// ---------- DOCX export ----------
// Mirrors buildManuscriptPdf() in pdf-export.js — a title "page", then each chapter starting on
// its own page — but via the `docx` package instead of hand-drawn PDF text, entirely on-device
// (Packer.toBlob runs in the browser, no server round-trip, same "no upload anywhere" policy as
// every other export path in this file).
//
// Same simplification PDF export already makes: a chapter's stored HTML is flattened to plain
// paragraphs via stripHtml (the same helper buildManuscriptText/buildManuscriptPdf both already
// use), so inline bold/italic runs aren't preserved. Word is the one export format where readers
// would actually expect to keep editing/reformatting the text afterward, so preserving structure
// (real paragraph breaks, a real heading style per chapter, a real page break between chapters)
// matters more here than it does for PDF — that's what this keeps, just not inline emphasis.
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { stripHtml } from '../shared-utils/strip-html.jsx';

// Splits a chapter's plain text into paragraphs (blank-line separated) — identical rule to
// pdf-export.js's own paragraphsOf, kept as its own small copy rather than a shared import so
// each export module stays a self-contained, independently-loadable chunk (see the dynamic
// import in ExportWorkPanel below).
function paragraphsOf(plainText) {
    return plainText.split(/\n{2,}|\n/).map((p) => p.trim());
}

// Returns a Blob (the .docx file itself) — Packer.toBlob already hands back a browser Blob
// directly, so there's no intermediate bytes step the way pdf-lib's pdfDoc.save() needs.
export async function buildManuscriptDocx(project) {
    const children = [];

    if (project.title) {
        children.push(new Paragraph({
            children: [new TextRun({ text: project.title, bold: true })],
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
        }));
    }
    if (project.author) {
        children.push(new Paragraph({
            children: [new TextRun({ text: `by ${project.author}`, italics: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
        }));
    }

    const chapters = (project.chapters || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
    chapters.forEach((ch) => {
        children.push(new Paragraph({
            children: [new TextRun({ text: ch.title || `Chapter ${ch.number || ''}`, bold: true })],
            heading: HeadingLevel.HEADING_1,
            pageBreakBefore: true,
            spacing: { after: 240 },
        }));
        const bodyText = stripHtml(ch.text).trim();
        paragraphsOf(bodyText).forEach((para) => {
            children.push(new Paragraph({
                children: para ? [new TextRun(para)] : [],
                spacing: { after: 200 },
            }));
        });
    });

    const doc = new Document({
        creator: 'Inkroot',
        title: project.title || 'Untitled Manuscript',
        sections: [{ children }],
    });
    return Packer.toBlob(doc);
}
