// Admin dashboard client. Talks to /api/admin/* and /api/auth/*.
// Both whitelisted accounts map to the editor role and get all three tabs:
// Record, Review, Add Content. No build step, no framework, matches the site.

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) { showSignin('Your session expired. Sign in again.'); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function showSignin(msg) {
  $('#app').classList.add('hidden');
  $('#signin').classList.remove('hidden');
  if (msg) $('#signin-msg').textContent = msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d.length === 10 ? `${d}T00:00:00` : d)
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ----------------------------------------------------------- Creator view

const recorder = { mediaRecorder: null, chunks: [], blob: null, topicId: null };

function renderCreator(state) {
  const topic = state.upcomingTopic;
  if (!topic) {
    $('#g-topic').textContent = 'No upcoming topic';
    $('#record-status').textContent = 'Nothing scheduled right now. Check back soon.';
    return;
  }
  recorder.topicId = topic.id;
  $('#g-topic').textContent = topic.title;
  $('#g-date').textContent = topic.scheduled_date ? `Goes live ${fmtDate(topic.scheduled_date)}` : '';
  $('#g-questions').innerHTML = (topic.guiding_questions || [])
    .map((q) => `<li>${escapeHtml(q)}</li>`).join('');
  $('#record-btn').disabled = false;
}

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder.chunks = [];
  const mimeTypes = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  const mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
  const options = { audioBitsPerSecond: 64000 };
  if (mimeType) options.mimeType = mimeType;
  recorder.mediaRecorder = new MediaRecorder(stream, options);
  recorder.mediaRecorder.ondataavailable = (e) => { if (e.data.size) recorder.chunks.push(e.data); };
  recorder.mediaRecorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder.blob = new Blob(recorder.chunks, { type: recorder.mediaRecorder.mimeType });
    const playback = $('#playback');
    playback.src = URL.createObjectURL(recorder.blob);
    playback.classList.remove('hidden');
    $('#record-confirm').classList.remove('hidden');
    $('#submit-btn').classList.remove('hidden');
    $('#record-status').textContent = 'Listen back, then submit, or record again to replace it.';
  };
  recorder.mediaRecorder.start();
  const btn = $('#record-btn');
  btn.textContent = 'Stop'; btn.classList.add('recording');
  $('#record-status').textContent = 'Recording… talk for a minute or two.';
}

function stopRecording() {
  recorder.mediaRecorder?.stop();
  const btn = $('#record-btn');
  btn.textContent = 'Record'; btn.classList.remove('recording');
}

function wireRecorder() {
  $('#record-btn').addEventListener('click', async () => {
    const btn = $('#record-btn');
    try {
      if (btn.classList.contains('recording')) stopRecording();
      else await startRecording();
    } catch {
      $('#record-status').innerHTML = '<span class="err">Microphone access was blocked. Allow it in your browser and try again.</span>';
    }
  });

  $('#submit-btn').addEventListener('click', async () => {
    if (!recorder.blob) return;
    $('#submit-btn').disabled = true;
    $('#record-status').textContent = 'Uploading and transcribing…';
    try {
      const audio_base64 = await blobToBase64(recorder.blob);
      const r = await api('/api/admin/record', {
        method: 'POST',
        body: JSON.stringify({ topic_id: recorder.topicId, audio_base64, mime: recorder.blob.type }),
      });
      $('#record-status').innerHTML = `Got it. The post will go live on schedule.<br><span class="meta">${escapeHtml(r.transcript_preview)}…</span>`;
      $('#record-btn').disabled = true;
      $('#submit-btn').classList.add('hidden');
      $('#record-confirm').classList.add('hidden');
    } catch (err) {
      $('#record-status').innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
      $('#submit-btn').disabled = false;
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------- Editor view

function renderEditor(state) {
  const on = state.editorToggle === 'on';
  $('#toggle').checked = on;
  updateToggleDesc(on);

  $('#pending').innerHTML = state.pendingPosts.length
    ? '' : '<p class="meta">No drafts waiting for review.</p>';
  state.pendingPosts.forEach((post) => $('#pending').appendChild(buildPostEditor(post)));

  $('#published').innerHTML = state.publishedPosts.map((p) => `
    <div class="pub-item">
      <a href="/blog/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
      <span class="meta">${fmtDate(p.published_at)}</span>
    </div>`).join('') || '<p class="meta">Nothing published yet.</p>';
}

function updateToggleDesc(on) {
  $('#toggle-desc').textContent = on
    ? 'ON — drafts wait here for your approval before going live.'
    : 'OFF — drafts auto-publish at the scheduled time without review.';
}

// Read-only external-links panel: what the hourly link sweep found for this
// draft (annotation only — the links themselves live in the body markdown).
// A link whose relevancy reasoning signals a contradiction gets a visible
// flag, since a contradicting source usually means the draft's claim needs
// a factual look before publishing.
const CONTRADICTION_RE = /contradict|conflicts? with|disagrees?|disputes?|refutes?|understat|overstat/i;

function buildLinksPanel(post) {
  const rows = (post.injected_links || []).slice().sort((a, b) => {
    const order = { injected: 0, flagged: 1, surplus: 2 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });
  if (rows.length === 0) {
    const msg = post.links_checked_at
      ? 'Checked — no qualifying external sources found for this draft.'
      : 'Link check pending — the sweep has not processed this draft yet.';
    return `<div class="field"><label>External links</label><p class="meta">${msg}</p></div>`;
  }
  // Rows can exist before links_checked_at is stamped (e.g. the manual
  // `npm run links:inject -- --apply` escape hatch) — surface that distinctly
  // from the zero-rows "hasn't run yet" message above, since it's also why
  // Publish is disabled below.
  const sweepPending = !post.links_checked_at
    ? '<p class="meta lint-warn">Sweep pending — the link check has not completed for this draft; Publish is disabled until it does.</p>'
    : '';
  const items = rows.map((l) => {
    const contradiction = l.relevancy_reasoning && CONTRADICTION_RE.test(l.relevancy_reasoning)
      ? `<div class="lint-warn">Possible contradiction — this source may dispute the draft's claim: ${escapeHtml(l.relevancy_reasoning)}</div>`
      : '';
    return `<div style="margin-bottom:10px;">
      <span class="chips"><span>${escapeHtml(l.status)}</span></span>
      <strong>${escapeHtml(l.anchor_text || '(no anchor)')}</strong>
      &rarr; <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a>
      <span class="meta">relevancy ${l.relevancy_score ?? '&mdash;'} &middot; trust ${l.trust_score ?? '&mdash;'}</span>
      ${contradiction}
    </div>`;
  }).join('');
  return `<div class="field"><label>External links (auto-injected, read-only)</label>${sweepPending}${items}</div>`;
}

function buildPostEditor(post) {
  const el = document.createElement('div');
  el.className = 'post-editor';
  // Admin is served from the client's site origin, so this matches SITE_ORIGIN.
  const postUrl = `${window.location.origin}/blog/${post.slug}`;
  const lintWarn = post.craft_audit && /FAIL/.test(post.craft_audit)
    ? '<div class="lint-warn">Lint flagged issues in this draft. Review the body before publishing.</div>' : '';
  el.innerHTML = `
    ${lintWarn}
    ${buildLinksPanel(post)}
    <div class="field">
      <label>Title</label>
      <input data-f="title" value="${escapeHtml(post.title)}">
    </div>
    <div class="field">
      <label>Meta title <span class="charcount"></span></label>
      <input data-f="meta_title" value="${escapeHtml(post.meta_title || '')}">
    </div>
    <div class="field">
      <label>Meta description <span class="charcount"></span></label>
      <input data-f="meta_description" value="${escapeHtml(post.meta_description || '')}">
    </div>
    <div class="field">
      <label>Keywords</label>
      <div class="chips">${(post.keywords_used || [post.primary_keyword]).filter(Boolean).map((k) => `<span>${escapeHtml(k)}</span>`).join('')}</div>
    </div>
    <div class="field">
      <label>Image</label>
      <p class="meta">${post.image_used ? escapeHtml(post.image_used) : 'None (image handling is a later phase)'}</p>
    </div>
    <div class="field">
      <label>Body (markdown)</label>
      <textarea class="body" data-f="body_md">${escapeHtml(post.body_md)}</textarea>
    </div>
    <div class="field">
      <label>LinkedIn draft</label>
      <textarea class="social" data-f="social_linkedin">${escapeHtml(post.social_linkedin || '')}</textarea>
    </div>
    <div class="field">
      <label>Paste in comments</label>
      <input class="copy-url" type="text" readonly value="${escapeHtml(postUrl)}" onclick="this.select()">
    </div>
    <div class="field">
      <label>Facebook draft</label>
      <textarea class="social" data-f="social_facebook">${escapeHtml(post.social_facebook || '')}</textarea>
    </div>
    <div class="field">
      <label>Paste in comments</label>
      <input class="copy-url" type="text" readonly value="${escapeHtml(postUrl)}" onclick="this.select()">
    </div>
    <button class="btn btn--primary" data-action="publish"${post.links_checked_at ? '' : ' disabled'}>Publish</button>
    <span class="publish-msg meta"></span>
  `;

  // Live char counts on the meta fields (55/155 SEO targets).
  const wireCount = (sel, max) => {
    const input = el.querySelector(`[data-f="${sel}"]`);
    const label = input.closest('.field').querySelector('.charcount');
    const upd = () => { label.textContent = `${input.value.length}/${max}`;
      label.style.color = input.value.length > max ? '#c0392b' : ''; };
    input.addEventListener('input', upd); upd();
  };
  wireCount('meta_title', 55);
  wireCount('meta_description', 155);

  el.querySelector('[data-action="publish"]').addEventListener('click', async (e) => {
    const btn = e.target;
    const msg = el.querySelector('.publish-msg');
    if (!post.links_checked_at) {
      msg.textContent = 'Link check pending — cannot publish yet.';
      return;
    }
    if (!confirm('Publish this post now? It will commit to the live site.')) return;
    btn.disabled = true; msg.textContent = 'Publishing…'; msg.className = 'publish-msg meta';
    const edits = {};
    el.querySelectorAll('[data-f]').forEach((i) => { edits[i.dataset.f] = i.value; });
    try {
      const r = await api('/api/admin/publish', { method: 'POST', body: JSON.stringify({ post_id: post.id, ...edits }) });
      msg.innerHTML = `Published. <a href="${escapeHtml(r.post_url)}" target="_blank" rel="noopener">View</a>`;
      if (r.post_commit_errors?.length) {
        msg.innerHTML += ` <span class="err">(some post-publish steps failed: ${r.post_commit_errors.map((x) => escapeHtml(x.step)).join(', ')})</span>`;
      }
      el.querySelector('[data-action="publish"]').disabled = true;
    } catch (err) {
      msg.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
      btn.disabled = false;
    }
  });

  return el;
}

// ----------------------------------------------------- Upcoming topics queue

async function loadUpcomingTopics() {
  const host = $('#upcoming-topics');
  try {
    const { topics } = await api('/api/admin/topics?status=upcoming');
    host.innerHTML = topics.length ? `
      <table class="upcoming-table">
        <thead><tr><th>Topic Title</th><th>Scheduled Date</th><th>Status</th></tr></thead>
        <tbody>${topics.map((t) => `
          <tr><td>${escapeHtml(t.title)}</td><td>${fmtDate(t.scheduled_date)}</td><td>${escapeHtml(t.status)}</td></tr>`).join('')}
        </tbody>
      </table>` : '<p class="meta">No upcoming topics.</p>';
  } catch (err) {
    host.innerHTML = `<p class="err">${escapeHtml(err.message)}</p>`;
  }
}

// --------------------------------------------------------- Add Content view

// A preview card for a generated/extracted topic, with Save and Discard.
// onActed() fires after the card leaves the DOM (saved or discarded).
function buildTopicCard(topic, onActed) {
  const el = document.createElement('div');
  el.className = 'topic-card';
  el.innerHTML = `
    ${topic.category ? `<span class="cat">${escapeHtml(topic.category)}</span><br>` : ''}
    <h4>${escapeHtml(topic.title)}</h4>
    <p>${escapeHtml(topic.description || '')}</p>
    <p class="kw">Main keyword: ${escapeHtml(topic.main_keyword || '')}</p>
    <ul>${(topic.guiding_questions || []).map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
    <div class="card-actions">
      <button class="btn btn--primary" data-act="save">Save</button>
      <button class="btn" data-act="discard">Discard</button>
    </div>
    <span class="card-msg meta"></span>`;

  const msg = el.querySelector('.card-msg');
  el.querySelector('[data-act="discard"]').addEventListener('click', () => { el.remove(); onActed?.(); });
  el.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
    const saveBtn = e.target;
    saveBtn.disabled = true; msg.textContent = 'Saving…'; msg.className = 'card-msg meta';
    try {
      await api('/api/admin/topics', {
        method: 'POST',
        body: JSON.stringify({
          title: topic.title,
          description: topic.description,
          category: topic.category,
          main_keyword: topic.main_keyword,
          guiding_questions: topic.guiding_questions,
        }),
      });
      el.remove(); onActed?.();
    } catch (err) {
      msg.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
      saveBtn.disabled = false;
    }
  });
  return el;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function wireAddContent() {
  // ---- Section A: Generate Topics (AI) ----
  const genBtn = $('#gen-topics-btn');
  const moreBtn = $('#gen-more-btn');
  const genMsg = $('#gen-topics-msg');
  const genResults = $('#gen-topics-results');

  async function generateTopics(btn) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Generating…';
    genMsg.textContent = ''; moreBtn.classList.add('hidden');
    try {
      const { topics } = await api('/api/admin/topics?action=generate', { method: 'POST', body: '{}' });
      genResults.innerHTML = '';
      const onActed = () => {
        // Once every card has been saved or discarded, offer another batch.
        if (!genResults.querySelector('.topic-card')) moreBtn.classList.remove('hidden');
      };
      topics.forEach((t) => genResults.appendChild(buildTopicCard(t, onActed)));
    } catch (err) {
      genMsg.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }
  genBtn.addEventListener('click', () => generateTopics(genBtn));
  moreBtn.addEventListener('click', () => generateTopics(moreBtn));

  // ---- Section B: Bulk Upload ----
  $('#bulk-btn').addEventListener('click', async () => {
    const file = $('#bulk-file').files[0];
    const msg = $('#bulk-msg');
    const results = $('#bulk-results');
    if (!file) { msg.innerHTML = '<span class="err">Choose a .md or .pdf file first.</span>'; return; }
    const btn = $('#bulk-btn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Reading file…'; msg.textContent = ''; results.innerHTML = '';
    try {
      const data_base64 = await fileToBase64(file);
      const { count } = await api('/api/admin/topics?action=bulk-upload', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mime: file.type, data_base64 }),
      });
      results.innerHTML = '';
      msg.innerHTML = `<span class="ok">${count} topic${count === 1 ? '' : 's'} saved.</span>`;
    } catch (err) {
      msg.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  // ---- Section C: Manual Entry ----
  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const msg = $('#manual-msg');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; msg.textContent = 'Saving…'; msg.className = 'meta';
    const fd = new FormData(form);
    try {
      await api('/api/admin/topics', {
        method: 'POST',
        body: JSON.stringify({
          title: fd.get('title'),
          description: fd.get('description'),
          category: fd.get('category'),
          main_keyword: fd.get('main_keyword'),
          guiding_questions: fd.get('guiding_questions'), // newline-delimited; server splits
          scheduled_date: fd.get('scheduled_date'),
        }),
      });
      msg.innerHTML = '<span class="ok">Topic saved.</span>';
      form.reset();
    } catch (err) {
      msg.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Section D: Image Upload ----
  $('#img-btn').addEventListener('click', async () => {
    const file = $('#img-file').files[0];
    const category = $('#img-category').value;
    const msg = $('#img-msg');
    if (!file) { msg.innerHTML = '<span class="err">Choose an image first.</span>'; return; }
    if (!category) { msg.innerHTML = '<span class="err">Choose a category.</span>'; return; }
    const btn = $('#img-btn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Uploading…'; msg.textContent = '';
    try {
      const data_base64 = await fileToBase64(file);
      await api('/api/admin/media?action=image-upload', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mime: file.type, data_base64, category }),
      });
      msg.innerHTML = '<span class="ok">Image added to library</span>';
      $('#img-file').value = ''; $('#img-category').value = '';
    } catch (err) {
      msg.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });
}

function wireEditorChrome() {
  $('#toggle').addEventListener('change', async (e) => {
    // Confirm before the toggle state takes effect. On cancel, revert the
    // checkbox and make no API call so the stored value is untouched.
    if (!confirm('Are you sure? Posts will automatically go live.')) {
      e.target.checked = !e.target.checked;
      return;
    }
    const value = e.target.checked ? 'on' : 'off';
    updateToggleDesc(e.target.checked);
    try {
      await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ editor_toggle: value }) });
    } catch (err) {
      alert(`Could not save toggle: ${err.message}`);
      e.target.checked = !e.target.checked;
      updateToggleDesc(e.target.checked);
    }
  });

  document.querySelectorAll('.admin-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      const which = tab.dataset.tab;
      $('#view-creator').classList.toggle('hidden', which !== 'creator');
      $('#view-editor').classList.toggle('hidden', which !== 'editor');
      $('#view-addcontent').classList.toggle('hidden', which !== 'addcontent');
    });
  });
}

// ----------------------------------------------------------------- init

async function init() {
  wireRecorder();
  let state;
  try {
    state = await api('/api/admin/status');
  } catch {
    return; // 401 already routed to sign-in
  }

  $('#app').classList.remove('hidden');
  $('#signin').classList.add('hidden');
  $('#who').textContent = state.email;

  // Brand name comes from CLIENT.adminBrandName via the status API, so the
  // static admin shell needs no per-client edit.
  if (state.brandName) {
    $('#brand').textContent = state.brandName;
    document.title = state.brandName;
  }

  renderCreator(state);

  if (state.role === 'editor') {
    $('#tabs').classList.remove('hidden');
    wireEditorChrome();
    renderEditor(state);
    wireAddContent();
    loadUpcomingTopics();
  } else {
    // Legacy creator role (no longer assigned): no tabs, only the Record view.
    $('#view-editor').remove();
    $('#view-addcontent').remove();
  }
}

init();
