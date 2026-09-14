import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";

export type CertificateDetails = {
  fullName: string;
  activityPeriod: string;
  roleName: string;
  issuedOn: string;
  organizationName: string;
  organizationAddress: string;
  issuerTitle: string;
  issuerName: string;
  contactEmail: string;
};

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

export async function createCertificatePdf(
  details: CertificateDetails,
  fontBytes: ArrayBuffer,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // CJK fonts can render corrupted glyphs when subset by fontkit; embed the full font instead.
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
  const navy = rgb(0.08, 0.16, 0.29);
  const gray = rgb(0.27, 0.31, 0.35);

  page.drawRectangle({ x: 35, y: 35, width: A4_WIDTH - 70, height: A4_HEIGHT - 70, borderColor: navy, borderWidth: 1.5 });
  drawCentered(page, "ボランティア活動証明書", font, 27, A4_HEIGHT - 135, navy);
  drawCentered(page, "Volunteer Activity Certificate", font, 11, A4_HEIGHT - 160, gray);

  drawCentered(page, `${details.fullName} 様`, font, 20, A4_HEIGHT - 235, navy);
  drawWrappedCentered(page, "上記の者が下記のとおりボランティア活動に従事したことを証明します。", font, 13, A4_HEIGHT - 285, gray, 480);

  const rows: Array<[string, string]> = [
    ["活動期間", details.activityPeriod],
    ["役職", details.roleName],
    ["発行日", details.issuedOn],
  ];
  let y = A4_HEIGHT - 370;
  for (const [label, value] of rows) {
    page.drawRectangle({ x: 90, y: y - 12, width: 100, height: 32, color: rgb(0.93, 0.95, 0.97) });
    page.drawText(label, { x: 112, y, font, size: 12, color: navy });
    page.drawText(value, { x: 210, y, font, size: 12, color: gray });
    y -= 52;
  }

  const issuerLines = [
    details.organizationName,
    details.organizationAddress,
    `${details.issuerTitle}　${details.issuerName}`,
    details.contactEmail,
  ];
  y = 180;
  for (const line of issuerLines) {
    const width = font.widthOfTextAtSize(line, 11);
    page.drawText(line, { x: A4_WIDTH - 80 - width, y, font, size: 11, color: gray });
    y -= 23;
  }

  return pdf.save();
}

type PdfPage = ReturnType<PDFDocument["addPage"]>;

function drawCentered(page: PdfPage, text: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number, y: number, color: ReturnType<typeof rgb>): void {
  page.drawText(text, { x: (A4_WIDTH - font.widthOfTextAtSize(text, size)) / 2, y, font, size, color });
}

function drawWrappedCentered(page: PdfPage, text: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number, y: number, color: ReturnType<typeof rgb>, maxWidth: number): void {
  const words = Array.from(text);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(line + word, size) > maxWidth && line !== "") {
      lines.push(line);
      line = word;
    } else {
      line += word;
    }
  }
  if (line) lines.push(line);
  lines.forEach((value, index) => drawCentered(page, value, font, size, y - index * (size + 5), color));
}
