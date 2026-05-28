import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit/js/pdfkit.standalone.js";

function formatInr(paise) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(Number(paise || 0) / 100));
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(date));
}

function sellerDetails() {
  return {
    legalName: process.env.INVOICE_SELLER_LEGAL_NAME || "Vaishnavi Sharma",
    tradeName: process.env.INVOICE_SELLER_TRADE_NAME || "Keshvi Crafts",
    type: process.env.INVOICE_SELLER_TYPE || "Sole Proprietorship",
    address:
      process.env.INVOICE_SELLER_ADDRESS ||
      "167 L, In Front of Indane Gas Godam, New Colony, Madhopur, Surajkund, Gorakhpur, Uttar Pradesh - 273015",
    email: process.env.INVOICE_SELLER_EMAIL || "keshvicrafts@gmail.com",
    phone: process.env.INVOICE_SELLER_PHONE || "+91 7310045515",
    website: process.env.INVOICE_SELLER_WEBSITE || "www.keshvicrafts.in",
    founderName: process.env.INVOICE_FOUNDER_NAME || "Vaishnavi"
  };
}

function resolveAssetPath(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  const candidates = [
    path.join(process.cwd(), ...parts),
    ...(process.env.KESHVI_WEBSITE_ROOT ? [path.join(process.env.KESHVI_WEBSITE_ROOT, ...parts)] : [])
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function imageDataUri(assetPath) {
  if (!assetPath) return null;
  const base64 = fs.readFileSync(assetPath).toString("base64");
  return `data:image/png;base64,${base64}`;
}

function addKeyValue(doc, key, value, x, y, width = 220) {
  doc.fillColor("#7a6255").fontSize(8).font("Helvetica-Bold").text(key.toUpperCase(), x, y, { width });
  doc.fillColor("#3b2a22").fontSize(10).font("Helvetica").text(value || "-", x, y + 13, { width });
}

export async function renderInvoicePdf(invoice) {
  const seller = sellerDetails();
  const order = invoice.order;
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];

  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#fff8f1");

  const logoImage = imageDataUri(resolveAssetPath("public\\uploads\\hero\\logo.png"));
  if (logoImage) {
    doc.image(logoImage, 40, 30, { width: 76 });
  }

  doc.fillColor("#8b5e3c").font("Helvetica-Bold").fontSize(22).text(seller.tradeName.toUpperCase(), 128, 38);
  doc.fillColor("#7a6255").font("Helvetica").fontSize(9).text("Handmade with love | Crochet | Custom Gifts", 128, 66);
  doc.text(`${seller.legalName} | ${seller.type}`, 128, 84);
  doc.text(seller.address, 128, 98, { width: 290 });
  doc.text(`Email: ${seller.email} | Phone: ${seller.phone}`, 128, 126);
  doc.text(`Website: ${seller.website}`, 128, 140);

  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(26).text("INVOICE", 410, 38, { align: "right" });
  doc.roundedRect(445, 76, 108, 24, 12).fill("#e8f6ed");
  doc.fillColor("#2e7d32").fontSize(9).text("PAYMENT PAID", 461, 84);

  doc.moveTo(40, 166).lineTo(555, 166).strokeColor("#ead8c8").lineWidth(1).stroke();

  doc.roundedRect(40, 185, 515, 86, 8).fill("#fffaf5").strokeColor("#ead8c8").stroke();
  addKeyValue(doc, "Invoice No", invoice.invoiceNumber, 58, 204, 140);
  addKeyValue(doc, "Order ID", order.merchantTransactionId || order.id, 222, 204, 155);
  addKeyValue(doc, "Invoice Date", formatDate(invoice.createdAt), 400, 204, 120);
  addKeyValue(doc, "Order Status", order.orderStatus, 58, 245, 140);
  addKeyValue(doc, "Payment Method", order.paymentMethod, 222, 245, 140);
  addKeyValue(doc, "Payment Ref", order.payuTransactionId || "-", 400, 245, 120);

  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(12).text("Bill To", 40, 300);
  doc.fillColor("#3b2a22").font("Helvetica").fontSize(10).text(order.fullName, 40, 320);
  doc.text(`Phone: ${order.phoneNumber}`, 40, 336);
  if (order.email) doc.text(`Email: ${order.email}`, 40, 352, { width: 240 });

  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(12).text("Shipping Address", 315, 300);
  doc.fillColor("#3b2a22").font("Helvetica").fontSize(10).text(`${order.address}, ${order.city} - ${order.pincode}`, 315, 320, { width: 230 });

  const tableTop = 386;
  doc.roundedRect(40, tableTop, 515, 28, 8).fill("#fff1ea");
  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(9);
  doc.text("Item", 52, tableTop + 10, { width: 250 });
  doc.text("Qty", 320, tableTop + 10, { width: 45, align: "center" });
  doc.text("Unit Price", 380, tableTop + 10, { width: 75, align: "right" });
  doc.text("Total", 470, tableTop + 10, { width: 70, align: "right" });

  let y = tableTop + 42;
  order.items.forEach((item) => {
    const lineTotal = Number(item.priceAtPurchasePaise || 0) * Number(item.quantity || 0);
    doc.fillColor("#3b2a22").font("Helvetica").fontSize(9);
    doc.text(item.productTitle, 52, y, { width: 250 });
    doc.text(String(item.quantity), 320, y, { width: 45, align: "center" });
    doc.text(formatInr(item.priceAtPurchasePaise), 380, y, { width: 75, align: "right" });
    doc.text(formatInr(lineTotal), 470, y, { width: 70, align: "right" });
    y += 28;
  });

  const itemsSubtotal = order.items.reduce((sum, item) => {
    return sum + Number(item.priceAtPurchasePaise || 0) * Number(item.quantity || 0);
  }, 0);
  const adjustment = Number(order.totalAmountPaise || 0) - itemsSubtotal;
  y = Math.max(y + 18, 520);

  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(12).text("Payment Details", 40, y);
  doc.fillColor("#7a6255").font("Helvetica").fontSize(9).text(`PayU Transaction ID: ${order.payuTransactionId || "-"}`, 40, y + 22);
  doc.text(`Merchant TXN ID: ${order.merchantTransactionId || "-"}`, 40, y + 38);

  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(12).text("Amount Summary", 360, y);
  doc.fillColor("#3b2a22").font("Helvetica").fontSize(10);
  doc.text("Items subtotal", 360, y + 24);
  doc.text(formatInr(itemsSubtotal), 465, y + 24, { width: 80, align: "right" });
  doc.text("Shipping/discount adjustment", 360, y + 42);
  doc.text(formatInr(adjustment), 465, y + 42, { width: 80, align: "right" });
  doc.moveTo(360, y + 66).lineTo(545, y + 66).strokeColor("#ead8c8").stroke();
  doc.font("Helvetica-Bold").fontSize(14).text("Total Paid", 360, y + 78);
  doc.fillColor("#8b5e3c").text(formatInr(order.totalAmountPaise), 455, y + 78, { width: 90, align: "right" });

  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(11).text("A small note from us", 40, 660);
  doc.fillColor("#7a6255").font("Helvetica").fontSize(9).text(
    "Thank you for supporting handmade art. Every Keshvi Crafts product is made with care, patience, and love.",
    40,
    678,
    { width: 310 }
  );

  doc.fillColor("#7a6255").fontSize(9).text("With gratitude,", 402, 650, { width: 145, align: "right" });
  const signatureImage = imageDataUri(resolveAssetPath("public\\uploads\\invoice\\signature.png"));
  if (signatureImage) {
    doc.image(signatureImage, 385, 665, { width: 160 });
  }
  doc.fillColor("#3b2a22").font("Helvetica-Bold").fontSize(12).text(seller.founderName, 370, 714, { width: 175, align: "right" });
  doc.fillColor("#7a6255").font("Helvetica").fontSize(9).text(`Founder, ${seller.tradeName}`, 370, 731, { width: 175, align: "right" });

  doc.moveTo(40, 760).lineTo(555, 760).strokeColor("#ead8c8").stroke();
  doc.fillColor("#8b5e3c").font("Helvetica-Bold").fontSize(9).text(`Thank you for shopping with ${seller.tradeName}`, 40, 772, { align: "center" });
  doc.fillColor("#7a6255").font("Helvetica").fontSize(8).text(
    `For order support, contact ${seller.email}. This digitally generated invoice is issued by ${seller.tradeName} for your records.`,
    50,
    788,
    { width: 495, align: "center", lineGap: 0 }
  );

  doc.end();
  return done;
}
