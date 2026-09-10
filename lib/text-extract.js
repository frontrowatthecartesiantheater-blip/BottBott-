// Extract plain text from an uploaded file, by extension/mime. Shared by the
// Add Content tab's topic bulk-upload (api/admin/topics.js) and the Record
// screen's notes/transcript upload (api/admin/record.js).
//
// .doc — the pre-2007 binary format — is deliberately not supported:
// reliably parsing it needs a native converter (antiword, LibreOffice) this
// serverless environment doesn't have. Word's own "Save As" offers .docx
// virtually everywhere .doc still shows up, so this is a real constraint,
// not laziness.

export const DOCUMENT_EXTS = ['docx', 'pdf', 'md', 'markdown', 'txt'];

export async function extractText({ filename, mime, buffer }) {
  const name = (filename || '').toLowerCase();
  const isDocx = name.endsWith('.docx')
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isPdf = name.endsWith('.pdf') || mime === 'application/pdf';
  const isMd = name.endsWith('.md') || name.endsWith('.markdown') || mime === 'text/markdown';
  const isTxt = name.endsWith('.txt') || mime === 'text/plain';

  if (isDocx) {
    try {
      const { default: mammoth } = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      return value || '';
    } catch {
      // mammoth's own failure here is JSZip's raw "is this a zip file?"
      // message — accurate but meaningless to someone who just picked a
      // file in a browser, so it never reaches the caller as-is.
      throw new Error("couldn't read that as a Word document — make sure it's a valid, unmodified .docx file");
    }
  }
  if (isMd || isTxt) return buffer.toString('utf8');
  if (isPdf) {
    try {
      // pdf-parse is CommonJS; import the inner module directly to avoid its
      // index.js debug-mode file read when there is no module.parent.
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
      const data = await pdfParse(buffer);
      return data.text || '';
    } catch {
      throw new Error("couldn't read that as a PDF — make sure it's a valid, unmodified file");
    }
  }
  throw new Error(`only ${DOCUMENT_EXTS.join(', ')} files are accepted`);
}
