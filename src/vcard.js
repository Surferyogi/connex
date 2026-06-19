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
// On iPhone/iPad this opens iOS's native contact card directly (Create New
// Contact / Add to Existing). On desktop it saves the .vcf, which opens in
// Contacts when you open the file. Note: a web app cannot write to iOS
// Contacts silently — opening the card for you to confirm is the closest a
// PWA can get, and it's intentionally after your confirmation anyway.
// Returns { method: "open" | "download" }.
export function addToContacts(card) {
  const vcf = buildVCard(card);
  const filename = `${safeFileName(card.full_name)}.vcf`;
  const blob = new Blob([vcf], { type: "text/vcard;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  const onIOS = isAppleTouch();
  if (onIOS) {
    // No `download` attribute: let iOS OPEN the card so you can review and
    // save it, rather than silently storing a file in Downloads.
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.download = filename; // desktop: save the file; opening it adds to Contacts
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return { method: onIOS ? "open" : "download" };
}
