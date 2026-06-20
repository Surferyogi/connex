// ---------------------------------------------------------------------------
// vCard generation + iOS Contacts hand-off.
//
// We emit vCard 3.0 in UTF-8 so Japanese/Korean/Chinese and accented names
// survive the import. The card photo is intentionally NOT embedded as the
// contact's avatar (a card scan is not a portrait); it stays in the app.
//
// Name order: business cards don't reliably tell us which token is the family
// name (e.g. CJK family-name-first vs. Western given-name-first). Rather than
// guess wrongly, we put the whole printed name in FN and the given-name slot.
// You can fix the split inside Contacts after import.
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function telType(label = "") {
  const l = label.toLowerCase();
  if (l.includes("mobile") || l.includes("cell") || l.includes("携帯")) return "CELL";
  if (l.includes("fax")) return "FAX";
  if (l.includes("home")) return "HOME";
  return "WORK,VOICE";
}

export function buildVCard(card) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];

  if (card.full_name) {
    lines.push(`N:;${esc(card.full_name)};;;`);
    lines.push(`FN:${esc(card.full_name)}`);
  } else {
    lines.push("FN: ");
  }
  if (card.name_phonetic) lines.push(`NICKNAME:${esc(card.name_phonetic)}`);

  if (card.company || card.department) {
    lines.push(`ORG:${esc(card.company || "")};${esc(card.department || "")}`);
  }
  if (card.job_title) lines.push(`TITLE:${esc(card.job_title)}`);

  (Array.isArray(card.phones) ? card.phones : []).forEach((p) => {
    if (p && p.number) lines.push(`TEL;TYPE=${telType(p.label)}:${esc(p.number)}`);
  });

  (Array.isArray(card.emails) ? card.emails : []).forEach((e) => {
    if (e) lines.push(`EMAIL;TYPE=INTERNET,WORK:${esc(e)}`);
  });

  if (card.website) lines.push(`URL:${esc(card.website)}`);
  if (card.address) lines.push(`ADR;TYPE=WORK:;;${esc(card.address)};;;;`);

  if (Array.isArray(card.tags) && card.tags.length) {
    lines.push(`CATEGORIES:${card.tags.map(esc).join(",")}`);
  }

  const note = [card.notes, "Scanned with Connex"].filter(Boolean).join("\n");
  lines.push(`NOTE:${esc(note)}`);
  lines.push(`REV:${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
  lines.push("END:VCARD");

  return lines.join("\r\n");
}

function safeFileName(name) {
  return (name || "contact").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
}

function isAppleTouch() {
  const ua = navigator.userAgent || "";
  const iOSLike = /iP(hone|ad|od)/.test(ua);
  // iPadOS reports as a Mac, so detect the touch screen too.
  const iPadOS = navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
  return iOSLike || iPadOS;
}

// One button → open the vCard so you can review, edit, and save it.
// On iPhone/iPad we navigate the current window straight to the vCard, which
// makes iOS open its CONTACT PREVIEW (the same view you get when tapping a
// .vcf in Files). From there: tap the share/actions icon → "Add to Contacts"
// → review/edit → Add. iOS gives no way to skip that final tap from a web app.
// (Using target=_blank instead pops a generic share sheet that buries the
// contact action behind document apps, so we navigate in place.)
// On desktop we save the .vcf, which opens in Contacts when you open the file.
// Returns { method: "open" | "download" }.
export function addToContacts(card) {
  const vcf = buildVCard(card);
  const filename = `${safeFileName(card.full_name)}.vcf`;
  const blob = new Blob([vcf], { type: "text/vcard;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  if (isAppleTouch()) {
    window.location.href = url; // iOS opens the contact preview in place
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { method: "open" };
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = filename; // desktop: save the file; opening it adds to Contacts
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { method: "download" };
}
