import { useEffect, useMemo, useRef, useState } from "react";
import { supabase, isConfigured } from "./supabaseClient.js";
import {
  processImage,
  scanCard,
  listCards,
  insertCard,
  updateCard,
  deleteCard,
  uploadImage,
  signedUrl,
} from "./api.js";
import { addToContacts } from "./vcard.js";

// Bump this on every edit to App.jsx — format vYYYY:MM:DD-HH:MM (Asia/Tokyo).
const APP_VERSION = "v2026:06:23-21:25";

const BLANK = {
  full_name: "",
  name_phonetic: "",
  job_title: "",
  department: "",
  company: "",
  website: "",
  address: "",
  notes: "",
  emails: [],
  phones: [],
  tags: [],
};

function fieldsToForm(f = {}) {
  return {
    full_name: f.full_name ?? "",
    name_phonetic: f.name_phonetic ?? "",
    job_title: f.job_title ?? "",
    department: f.department ?? "",
    company: f.company ?? "",
    website: f.website ?? "",
    address: f.address ?? "",
    notes: f.notes ?? "",
    emails: Array.isArray(f.emails) ? f.emails.filter(Boolean) : [],
    phones: Array.isArray(f.phones)
      ? f.phones.map((p) => ({ label: p?.label ?? "", number: p?.number ?? "" }))
      : [],
    tags: Array.isArray(f.tags) ? f.tags.filter(Boolean) : [],
  };
}

function formToRecord(form) {
  const orNull = (v) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  return {
    full_name: orNull(form.full_name),
    name_phonetic: orNull(form.name_phonetic),
    job_title: orNull(form.job_title),
    department: orNull(form.department),
    company: orNull(form.company),
    website: orNull(form.website),
    address: orNull(form.address),
    notes: orNull(form.notes),
    emails: form.emails.map((e) => e.trim()).filter(Boolean),
    phones: form.phones
      .filter((p) => (p.number ?? "").trim())
      .map((p) => ({ label: (p.label || "other").trim(), number: p.number.trim() })),
    tags: Array.from(
      new Set((form.tags || []).map((t) => t.trim()).filter(Boolean)),
    ),
  };
}

// --- crop helpers (no dependencies) ----------------------------------------
function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("load failed"));
    i.src = src;
  });
}

const FULL_RECT = { x1: 0, y1: 0, x2: 1, y2: 1 };

async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch failed");
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

async function cropImage(src, r, quality = 0.85) {
  const img = await loadImg(src);
  const nW = img.naturalWidth;
  const nH = img.naturalHeight;
  const sx = Math.round(r.x1 * nW);
  const sy = Math.round(r.y1 * nH);
  const sw = Math.max(1, Math.round((r.x2 - r.x1) * nW));
  const sh = Math.max(1, Math.round((r.y2 - r.y1) * nH));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.split(",")[1];
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return { blob, dataUrl, base64, mediaType: "image/jpeg", width: sw, height: sh };
}

export default function App() {
  if (!isConfigured) return <ConfigWarn />;

  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  const [cards, setCards] = useState([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [query, setQuery] = useState("");

  const [view, setView] = useState("list"); // list | crop | review | detail
  const [captured, setCaptured] = useState(null); // {front, back, rawFields, model}
  const [pendingCrop, setPendingCrop] = useState(null); // {img, target}
  const [form, setForm] = useState(BLANK);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);

  const [current, setCurrent] = useState(null); // card open in detail
  const [editing, setEditing] = useState(false);
  const [detailBack, setDetailBack] = useState(null); // pending back image in detail
  const [detailFront, setDetailFront] = useState(null); // pending front image in detail

  const [toast, setToast] = useState(null);
  const [stamp, setStamp] = useState(false);

  const fileRef = useRef(null);
  const flowRef = useRef("front"); // front | new-back | detail-front | detail-back

  const allTags = useMemo(() => {
    const s = new Set();
    cards.forEach((c) => (c.tags || []).forEach((t) => s.add(t)));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [cards]);

  function flash(msg, ms = 3600) {
    setToast(msg);
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setToast(null), ms);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) refresh();
    else setCards([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function refresh() {
    setLoadingCards(true);
    try {
      setCards(await listCards());
    } catch (e) {
      flash("Couldn’t load your cards.");
    } finally {
      setLoadingCards(false);
    }
  }

  // --- capture + crop + scan ------------------------------------------------
  function startScan() {
    flowRef.current = "front";
    fileRef.current?.click();
  }
  function pickBackForReview() {
    flowRef.current = "new-back";
    fileRef.current?.click();
  }
  function pickFrontForDetail() {
    flowRef.current = "detail-front";
    fileRef.current?.click();
  }
  function pickBackForDetail() {
    flowRef.current = "detail-back";
    fileRef.current?.click();
  }
  async function recropFront(url) {
    if (!url) return;
    try {
      const dataUrl = await urlToDataUrl(url);
      setPendingCrop({ img: { dataUrl }, target: "detail-front", initialRect: FULL_RECT });
      setView("crop");
    } catch {
      flash("Couldn’t load that photo to re-crop — try Retake instead.");
    }
  }
  async function recropBack(url) {
    if (!url) return;
    try {
      const dataUrl = await urlToDataUrl(url);
      setPendingCrop({ img: { dataUrl }, target: "detail-back", initialRect: FULL_RECT });
      setView("crop");
    } catch {
      flash("Couldn’t load that photo to re-crop — try Retake instead.");
    }
  }

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let img;
    try {
      img = await processImage(file);
    } catch {
      flash("That image couldn’t be opened.");
      return;
    }
    setPendingCrop({ img, target: flowRef.current });
    setView("crop");
  }

  async function runOcr(img) {
    setScanning(true);
    try {
      const { fields, model_used } = await scanCard(img.base64, img.mediaType);
      setForm((f) => ({ ...fieldsToForm(fields), tags: f.tags }));
      setCaptured((c) => ({ ...c, rawFields: fields, model: model_used }));
    } catch (err) {
      flash(err.message || "Couldn’t read the card — you can type it in.");
    } finally {
      setScanning(false);
    }
  }

  function onCropDone(cropped) {
    const target = pendingCrop?.target;
    setPendingCrop(null);
    if (target === "front") {
      setCaptured({ front: cropped, back: null, rawFields: null, model: null });
      setForm({ ...BLANK });
      setView("review");
      runOcr(cropped);
    } else if (target === "new-back") {
      setCaptured((c) => ({ ...c, back: cropped }));
      setView("review");
    } else if (target === "detail-front") {
      setDetailFront(cropped);
      setView("detail");
    } else if (target === "detail-back") {
      setDetailBack(cropped);
      setView("detail");
    }
  }

  function onCropCancel() {
    const target = pendingCrop?.target;
    setPendingCrop(null);
    if (target === "front") setView("list");
    else if (target === "new-back") setView("review");
    else setView("detail");
  }

  async function saveCard() {
    if (!session || !captured?.front) return;
    setSaving(true);
    try {
      const frontPath = await uploadImage(session.user.id, captured.front.blob);
      let backPath = null;
      if (captured.back) backPath = await uploadImage(session.user.id, captured.back.blob);
      const rec = {
        ...formToRecord(form),
        user_id: session.user.id,
        image_path: frontPath,
        image_path_back: backPath,
        raw_extraction: captured.rawFields,
        model_used: captured.model,
      };
      const saved = await insertCard(rec);
      setCards((cs) => [saved, ...cs]);
      setCaptured(null);
      setForm(BLANK);
      setView("list");
      setStamp(true);
      window.setTimeout(() => setStamp(false), 950);
    } catch (e) {
      flash(e.message || "Couldn’t save the card.");
    } finally {
      setSaving(false);
    }
  }

  // --- detail ---------------------------------------------------------------
  function openDetail(card) {
    setCurrent(card);
    setForm(fieldsToForm(card));
    setDetailBack(null);
    setDetailFront(null);
    setEditing(false);
    setView("detail");
  }

  async function saveEdits() {
    setSaving(true);
    try {
      const patch = formToRecord(form);
      const orphans = [];
      if (detailFront) {
        patch.image_path = await uploadImage(session.user.id, detailFront.blob);
        if (current.image_path) orphans.push(current.image_path);
      }
      if (detailBack) {
        patch.image_path_back = await uploadImage(session.user.id, detailBack.blob);
        if (current.image_path_back) orphans.push(current.image_path_back);
      }
      const updated = await updateCard(current.id, patch);
      setCards((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
      setCurrent(updated);
      setDetailBack(null);
      setDetailFront(null);
      setEditing(false);
      flash("Changes saved.");
      // Best-effort: remove the now-replaced photos so storage doesn't accrue orphans.
      if (orphans.length) {
        try {
          await supabase.storage.from("card-images").remove(orphans);
        } catch (_) {}
      }
    } catch (e) {
      flash(e.message || "Couldn’t save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function removeCard() {
    if (!window.confirm("Delete this card and its photos? This can’t be undone.")) return;
    try {
      await deleteCard(current);
      setCards((cs) => cs.filter((c) => c.id !== current.id));
      setCurrent(null);
      setView("list");
      flash("Card deleted.");
    } catch (e) {
      flash(e.message || "Couldn’t delete the card.");
    }
  }

  function handleAddToContacts(card) {
    const res = addToContacts(card);
    if (res.method === "open")
      flash("In the contact preview, tap the share icon → Add to Contacts → Add.", 6000);
    else flash("Contact card saved — open the .vcf to add it to Contacts.", 5200);
  }

  // --- tag management (propagates across every card) ------------------------
  async function renameTag(oldName, newName) {
    const n = (newName || "").trim();
    if (!n) return;
    const lower = oldName.toLowerCase();
    if (n.toLowerCase() === lower) return; // same name (ignoring case change handled below)
    const affected = cards.filter((c) =>
      (c.tags || []).some((t) => t.toLowerCase() === lower),
    );
    const remap = (tags) =>
      Array.from(new Set((tags || []).map((t) => (t.toLowerCase() === lower ? n : t))));
    try {
      for (const c of affected) {
        await updateCard(c.id, { tags: remap(c.tags) });
      }
      setCards((cs) =>
        cs.map((c) =>
          (c.tags || []).some((t) => t.toLowerCase() === lower)
            ? { ...c, tags: remap(c.tags) }
            : c,
        ),
      );
      flash(`Renamed to “${n}” on ${affected.length} card${affected.length === 1 ? "" : "s"}.`);
    } catch (e) {
      flash(e.message || "Couldn’t rename the tag.");
      refresh();
    }
  }

  async function deleteTag(name) {
    if (!window.confirm(`Remove the tag “${name}” from all cards?`)) return;
    const lower = name.toLowerCase();
    const affected = cards.filter((c) =>
      (c.tags || []).some((t) => t.toLowerCase() === lower),
    );
    const strip = (tags) => (tags || []).filter((t) => t.toLowerCase() !== lower);
    try {
      for (const c of affected) {
        await updateCard(c.id, { tags: strip(c.tags) });
      }
      setCards((cs) => cs.map((c) => ({ ...c, tags: strip(c.tags) })));
      flash(`Removed “${name}” from ${affected.length} card${affected.length === 1 ? "" : "s"}.`);
    } catch (e) {
      flash(e.message || "Couldn’t remove the tag.");
      refresh();
    }
  }

  // --- render ---------------------------------------------------------------
  if (!authReady) return <CenterLoad />;
  if (!session) return <AuthView flash={flash} />;

  return (
    <div className="app">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={onPick}
      />

      {view === "list" && (
        <ListView
          cards={cards}
          loading={loadingCards}
          query={query}
          setQuery={setQuery}
          allTags={allTags}
          onManageTags={() => setView("tags")}
          onOpen={openDetail}
          onSignOut={() => supabase.auth.signOut()}
        />
      )}

      {view === "tags" && (
        <ManageTagsView
          allTags={allTags}
          onRename={renameTag}
          onDelete={deleteTag}
          onBack={() => setView("list")}
        />
      )}

      {view === "crop" && pendingCrop && (
        <CropView
          src={pendingCrop.img.dataUrl}
          title={pendingCrop.target === "front" ? "Crop the card" : "Crop the photo"}
          initialRect={pendingCrop.initialRect}
          onDone={onCropDone}
          onCancel={onCropCancel}
        />
      )}

      {view === "review" && (
        <ReviewView
          captured={captured}
          form={form}
          setForm={setForm}
          suggestions={allTags}
          scanning={scanning}
          saving={saving}
          onSave={saveCard}
          onRetake={startScan}
          onAddBack={pickBackForReview}
          onRemoveBack={() => setCaptured((c) => ({ ...c, back: null }))}
          onCancel={() => {
            setCaptured(null);
            setForm(BLANK);
            setView("list");
          }}
        />
      )}

      {view === "detail" && current && (
        <DetailView
          card={current}
          form={form}
          setForm={setForm}
          suggestions={allTags}
          editing={editing}
          setEditing={setEditing}
          saving={saving}
          detailBack={detailBack}
          detailFront={detailFront}
          onRetakeFront={pickFrontForDetail}
          onRemovePendingFront={() => setDetailFront(null)}
          onRecropFront={recropFront}
          onRecropBack={recropBack}
          onAddBack={pickBackForDetail}
          onRemovePendingBack={() => setDetailBack(null)}
          onSaveEdits={saveEdits}
          onDelete={removeCard}
          onBack={() => {
            setEditing(false);
            setDetailBack(null);
            setDetailFront(null);
            setView("list");
          }}
          onAddToContacts={handleAddToContacts}
        />
      )}

      {view === "list" && (
        <div className="dock">
          <button className="btn btn-primary" onClick={startScan}>
            <span className="seal-mark" style={{ borderColor: "#fff" }} />
            Scan a card
          </button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      {stamp && (
        <div className="stamp-overlay">
          <div className="stamp">
            <span>Saved</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Crop ------------------------------------- */
function CropView({ src, title, initialRect, onDone, onCancel }) {
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const [rect, setRect] = useState(initialRect || { x1: 0.06, y1: 0.08, x2: 0.94, y2: 0.92 });
  const [busy, setBusy] = useState(false);

  const startDrag = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = stageRef.current.getBoundingClientRect();
    dragRef.current = {
      mode,
      rect: { ...rect },
      sx: (e.clientX - r.left) / r.width,
      sy: (e.clientY - r.top) / r.height,
    };
    try {
      stageRef.current.setPointerCapture(e.pointerId);
    } catch (_) {}
  };

  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const r = stageRef.current.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const dx = nx - d.sx;
    const dy = ny - d.sy;
    const MIN = 0.12;
    let { x1, y1, x2, y2 } = d.rect;
    if (d.mode === "move") {
      const w = x2 - x1;
      const h = y2 - y1;
      let a = Math.min(1 - w, Math.max(0, x1 + dx));
      let b = Math.min(1 - h, Math.max(0, y1 + dy));
      setRect({ x1: a, y1: b, x2: a + w, y2: b + h });
      return;
    }
    if (d.mode.includes("w")) x1 = Math.min(x2 - MIN, Math.max(0, x1 + dx));
    if (d.mode.includes("e")) x2 = Math.max(x1 + MIN, Math.min(1, x2 + dx));
    if (d.mode.includes("n")) y1 = Math.min(y2 - MIN, Math.max(0, y1 + dy));
    if (d.mode.includes("s")) y2 = Math.max(y1 + MIN, Math.min(1, y2 + dy));
    setRect({ x1, y1, x2, y2 });
  };

  const endDrag = (e) => {
    dragRef.current = null;
    try {
      stageRef.current.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };

  async function apply(useFull) {
    setBusy(true);
    try {
      const r = useFull ? { x1: 0, y1: 0, x2: 1, y2: 1 } : rect;
      const out = await cropImage(src, r);
      onDone(out);
    } catch {
      onDone(await cropImage(src, { x1: 0, y1: 0, x2: 1, y2: 1 }));
    } finally {
      setBusy(false);
    }
  }

  const maskStyle = {
    left: `${rect.x1 * 100}%`,
    top: `${rect.y1 * 100}%`,
    width: `${(rect.x2 - rect.x1) * 100}%`,
    height: `${(rect.y2 - rect.y1) * 100}%`,
  };

  return (
    <div className="screen">
      <div className="screen-top">
        <button className="back" onClick={onCancel}>
          ‹ Back
        </button>
        <h1>{title}</h1>
      </div>
      <p className="crop-note">Drag the corners to frame just the card.</p>
      <div
        className="crop-stage"
        ref={stageRef}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img className="crop-img" src={src} alt="" />
        <div className="crop-mask crop-grid" style={maskStyle} onPointerDown={startDrag("move")}>
          <div className="crop-handle" style={{ left: 0, top: 0 }} onPointerDown={startDrag("nw")} />
          <div className="crop-handle" style={{ left: "100%", top: 0 }} onPointerDown={startDrag("ne")} />
          <div className="crop-handle" style={{ left: 0, top: "100%" }} onPointerDown={startDrag("sw")} />
          <div className="crop-handle" style={{ left: "100%", top: "100%" }} onPointerDown={startDrag("se")} />
        </div>
      </div>
      <div className="stack">
        <button className="btn btn-primary" onClick={() => apply(false)} disabled={busy}>
          {busy ? <span className="spinner" /> : "Use this crop"}
        </button>
        <button className="btn btn-ghost" onClick={() => apply(true)} disabled={busy}>
          Use full photo
        </button>
        <button className="btn-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- List ------------------------------------- */
function ListView({ cards, loading, query, setQuery, allTags, onManageTags, onOpen, onSignOut }) {
  const [activeTag, setActiveTag] = useState(null);
  const [sort, setSort] = useState("date_desc");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = cards.filter((c) => {
      if (activeTag && !(c.tags || []).includes(activeTag)) return false;
      if (!q) return true;
      return [c.full_name, c.company, c.job_title, ...(c.emails || []), ...(c.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    const t = (c) => new Date(c.created_at).getTime() || 0;
    // Unnamed cards always sort to the bottom, regardless of A–Z / Z–A.
    const byName = (a, b, dir) => {
      const ax = (a.full_name || "").trim();
      const bx = (b.full_name || "").trim();
      if (!ax && !bx) return 0;
      if (!ax) return 1;
      if (!bx) return -1;
      const r = ax.toLowerCase().localeCompare(bx.toLowerCase());
      return dir === "asc" ? r : -r;
    };
    const cmp = {
      date_desc: (a, b) => t(b) - t(a),
      date_asc: (a, b) => t(a) - t(b),
      name_asc: (a, b) => byName(a, b, "asc"),
      name_desc: (a, b) => byName(a, b, "desc"),
    }[sort];

    return [...list].sort(cmp);
  }, [cards, query, activeTag, sort]);

  return (
    <>
      <header className="header">
        <div className="wordmark">
          <span className="seal-mark" />
          Connex
        </div>
        <button className="header-action" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <div className="content">
        {cards.length > 0 && (
          <div className="search-wrap">
            <input
              className="search"
              placeholder="Search name, company, email, tag…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="search-clear"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
        )}

        {cards.length > 1 && (
          <div className="sortbar">
            <label className="sortbar-label" htmlFor="sortsel">
              Sort
            </label>
            <select
              id="sortsel"
              className="sort-select"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="date_desc">Scanned: latest first</option>
              <option value="date_asc">Scanned: earliest first</option>
              <option value="name_asc">Name A → Z</option>
              <option value="name_desc">Name Z → A</option>
            </select>
          </div>
        )}

        {allTags.length > 0 && (
          <div className="tag-filter-head">
            <span className="tag-filter-title">Tags</span>
            <button className="link-btn" onClick={onManageTags}>
              Edit tags
            </button>
          </div>
        )}

        {allTags.length > 0 && (
          <div className="tag-filter">
            {allTags.map((t) => (
              <button
                key={t}
                className={"chip" + (activeTag === t ? " on" : "")}
                onClick={() => setActiveTag(activeTag === t ? null : t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {loading && cards.length === 0 ? (
          <div className="card-list">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <div className="seal-big" />
            <h2>{cards.length === 0 ? "No cards yet" : "No matches"}</h2>
            <p>
              {cards.length === 0
                ? "Tap Scan a card to capture your first one."
                : "Try a different name, company, or tag."}
            </p>
          </div>
        ) : (
          <div className="card-list">
            {visible.map((c) => (
              <button key={c.id} className="tile" onClick={() => onOpen(c)}>
                <Thumb card={c} />
                <div className="tile-body">
                  <div className="tile-name">{c.full_name || "Unnamed contact"}</div>
                  <div className="tile-sub">
                    {[c.job_title, c.company].filter(Boolean).join(" · ") || "—"}
                  </div>
                  {(c.tags || []).length > 0 && (
                    <div className="tile-tags">
                      {c.tags.map((t) => (
                        <span className="tile-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="foot">Connex {APP_VERSION}</div>
      </div>
    </>
  );
}

/* --------------------------- Manage tags ---------------------------------- */
function ManageTagsView({ allTags, onRename, onDelete, onBack }) {
  return (
    <div className="screen">
      <div className="screen-top">
        <button className="back" onClick={onBack}>
          ‹ Back
        </button>
        <h1>Manage tags</h1>
      </div>
      {allTags.length === 0 ? (
        <p className="tags-hint">No tags yet. Add tags to a card to see them here.</p>
      ) : (
        <>
          <p className="tags-hint">
            Rename a tag to update it on every card that uses it. Renaming into an
            existing tag merges them.
          </p>
          <div className="taglist">
            {allTags.map((t) => (
              <TagRow key={t} name={t} onRename={onRename} onDelete={onDelete} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TagRow({ name, onRename, onDelete }) {
  const [val, setVal] = useState(name);
  const [busy, setBusy] = useState(false);
  const changed = val.trim() && val.trim() !== name;
  return (
    <div className="tagrow">
      <input
        className="tagrow-input"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        spellCheck={false}
      />
      {changed ? (
        <button
          className="tagrow-save"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onRename(name, val);
            setBusy(false);
          }}
        >
          {busy ? <span className="spinner" /> : "Save"}
        </button>
      ) : (
        <button className="tagrow-del" onClick={() => onDelete(name)}>
          Delete
        </button>
      )}
    </div>
  );
}

function Thumb({ card }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let on = true;
    if (card.image_path) signedUrl(card.image_path).then((u) => on && setUrl(u));
    return () => {
      on = false;
    };
  }, [card.image_path]);
  if (url) return <img className="tile-thumb" src={url} alt="" />;
  const initial = (card.full_name || "·").trim().charAt(0).toUpperCase();
  return <div className="tile-thumb placeholder">{initial}</div>;
}

/* ------------------------------ Review ------------------------------------ */
function ReviewView({
  captured,
  form,
  setForm,
  suggestions,
  scanning,
  saving,
  onSave,
  onRetake,
  onAddBack,
  onRemoveBack,
  onCancel,
}) {
  return (
    <div className="screen">
      <div className="screen-top">
        <button className="back" onClick={onCancel}>
          ‹ Cancel
        </button>
        <h1>Review</h1>
      </div>

      <div className="shot-pair">
        <div className="shot-col">
          {captured?.front?.dataUrl && (
            <img className="shot" src={captured.front.dataUrl} alt="Front of card" />
          )}
          <div className="shot-cap">Front</div>
        </div>
        {captured?.back?.dataUrl && (
          <div className="shot-col">
            <img className="shot" src={captured.back.dataUrl} alt="Back of card" />
            <div className="shot-cap">Back</div>
          </div>
        )}
      </div>

      {captured?.back ? (
        <div className="back-actions">
          <button onClick={onAddBack}>Retake back</button>
          <button className="danger" onClick={onRemoveBack}>
            Remove back
          </button>
        </div>
      ) : (
        <button className="add-back" onClick={onAddBack}>
          + Add back of card
        </button>
      )}

      {scanning ? (
        <div className="read-note">
          <span className="spinner dark" />
          Reading the card…
        </div>
      ) : (
        <div className="read-note">
          <span aria-hidden>✦</span>
          Check each field below. Connex only fills in what it could read — it
          never guesses. Empty fields weren’t detected; add them if you like.
        </div>
      )}

      <CardForm form={form} setForm={setForm} suggestions={suggestions} markUndetected />

      <div className="stack">
        <button className="btn btn-primary" onClick={onSave} disabled={saving || scanning}>
          {saving ? <span className="spinner" /> : "Save card"}
        </button>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={onRetake} disabled={saving}>
            Retake front
          </button>
          <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Detail ------------------------------------ */
function DetailView({
  card,
  form,
  setForm,
  suggestions,
  editing,
  setEditing,
  saving,
  detailBack,
  detailFront,
  onRetakeFront,
  onRemovePendingFront,
  onRecropFront,
  onRecropBack,
  onAddBack,
  onRemovePendingBack,
  onSaveEdits,
  onDelete,
  onBack,
  onAddToContacts,
}) {
  const [frontUrl, setFrontUrl] = useState(null);
  const [backUrl, setBackUrl] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    let on = true;
    if (card.image_path) signedUrl(card.image_path).then((u) => on && setFrontUrl(u));
    if (card.image_path_back) signedUrl(card.image_path_back).then((u) => on && setBackUrl(u));
    return () => {
      on = false;
    };
  }, [card.image_path, card.image_path_back]);

  const rows = [
    ["Name", card.full_name],
    ["Reading", card.name_phonetic],
    ["Title", card.job_title],
    ["Department", card.department],
    ["Company", card.company],
    ["Website", card.website],
    ["Address", card.address],
  ].filter(([, v]) => v);

  return (
    <div className="screen">
      <div className="screen-top">
        <button className="back" onClick={onBack}>
          ‹ Cards
        </button>
        <h1>{editing ? "Edit" : "Contact"}</h1>
      </div>

      <div className="shot-pair">
        {frontUrl && (
          <div className="shot-col">
            <button className="shot-btn" onClick={() => setLightbox(frontUrl)}>
              <img className="shot" src={frontUrl} alt="Front of card" />
            </button>
            <div className="shot-cap">Front · tap to enlarge</div>
          </div>
        )}
        {backUrl && (
          <div className="shot-col">
            <button className="shot-btn" onClick={() => setLightbox(backUrl)}>
              <img className="shot" src={backUrl} alt="Back of card" />
            </button>
            <div className="shot-cap">Back · tap to enlarge</div>
          </div>
        )}
      </div>
      {lightbox && <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />}

      {editing ? (
        <>
          <CardForm form={form} setForm={setForm} suggestions={suggestions} />

          <div className="photos-edit">
            <div className="photos-edit-label">Photos</div>

            {detailFront ? (
              <>
                <div className="shot-pair">
                  <div className="shot-col">
                    <img className="shot" src={detailFront.dataUrl} alt="New front of card" />
                    <div className="shot-cap">New front</div>
                  </div>
                </div>
                <div className="back-actions">
                  <button className="danger" onClick={onRemovePendingFront}>
                    Undo new front
                  </button>
                </div>
              </>
            ) : (
              <div className="photo-row">
                <span className="photo-row-label">Front</span>
                <div className="photo-actions">
                  <button className="photo-act" onClick={onRetakeFront}>
                    ↻ Retake
                  </button>
                  {frontUrl && (
                    <button className="photo-act" onClick={() => onRecropFront(frontUrl)}>
                      ✂ Re-crop
                    </button>
                  )}
                </div>
              </div>
            )}

            {detailBack ? (
              <>
                <div className="shot-pair">
                  <div className="shot-col">
                    <img className="shot" src={detailBack.dataUrl} alt="New back of card" />
                    <div className="shot-cap">New back</div>
                  </div>
                </div>
                <div className="back-actions">
                  <button className="danger" onClick={onRemovePendingBack}>
                    Undo new back
                  </button>
                </div>
              </>
            ) : card.image_path_back ? (
              <div className="photo-row">
                <span className="photo-row-label">Back</span>
                <div className="photo-actions">
                  <button className="photo-act" onClick={onAddBack}>
                    ↻ Retake
                  </button>
                  {backUrl && (
                    <button className="photo-act" onClick={() => onRecropBack(backUrl)}>
                      ✂ Re-crop
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button className="add-back" onClick={onAddBack}>
                + Add back of card
              </button>
            )}
          </div>

          <div className="stack">
            <button className="btn btn-primary" onClick={onSaveEdits} disabled={saving}>
              {saving ? <span className="spinner" /> : "Save changes"}
            </button>
            <button className="btn-text" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {rows.map(([k, v]) => (
            <div className="detail-field" key={k}>
              <div className="k">{k}</div>
              <div className="v">{v}</div>
            </div>
          ))}
          {(card.phones || []).map((p, i) => (
            <div className="detail-field" key={"p" + i}>
              <div className="k">{p.label || "Phone"}</div>
              <div className="v">
                <a href={`tel:${p.number}`}>{p.number}</a>
              </div>
            </div>
          ))}
          {(card.emails || []).map((e, i) => (
            <div className="detail-field" key={"e" + i}>
              <div className="k">Email</div>
              <div className="v">
                <a href={`mailto:${e}`}>{e}</a>
              </div>
            </div>
          ))}
          {card.notes && (
            <div className="detail-field">
              <div className="k">Notes</div>
              <div className="v">{card.notes}</div>
            </div>
          )}
          {(card.tags || []).length > 0 && (
            <div className="detail-field">
              <div className="k">Tags</div>
              <div className="chips" style={{ marginTop: 6 }}>
                {card.tags.map((t) => (
                  <span className="chip on" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="detail-meta">
            Saved {new Date(card.created_at).toLocaleDateString()} · you confirm
            before anything is added to Contacts.
          </div>

          <div className="stack">
            <button className="btn btn-seal" onClick={() => onAddToContacts(card)}>
              <span className="seal-mark" style={{ borderColor: "#fff" }} />
              Add to Contacts
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              Edit details
            </button>
            <button className="btn-text danger" onClick={onDelete}>
              Delete card
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------- Shared form ---------------------------------- */
function CardForm({ form, setForm, suggestions = [], markUndetected = false }) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const cls = (v) => "field" + (markUndetected && !v ? " undetected" : "");

  const setPhone = (i, key) => (e) =>
    setForm((f) => {
      const phones = f.phones.slice();
      phones[i] = { ...phones[i], [key]: e.target.value };
      return { ...f, phones };
    });
  const setEmail = (i) => (e) =>
    setForm((f) => {
      const emails = f.emails.slice();
      emails[i] = e.target.value;
      return { ...f, emails };
    });

  const text = (k, label) => (
    <div className={cls(form[k])}>
      <label>{label}</label>
      <input
        value={form[k]}
        onChange={set(k)}
        placeholder={markUndetected ? "Not detected — add if needed" : ""}
      />
    </div>
  );

  return (
    <div className="fields">
      {text("full_name", "Name")}
      {text("name_phonetic", "Reading / romanization")}
      {text("job_title", "Title")}
      {text("department", "Department")}
      {text("company", "Company")}

      <div className="field">
        <label>Phones</label>
        {form.phones.map((p, i) => (
          <div className="multi-row" key={i}>
            <input
              className="label-in"
              value={p.label}
              onChange={setPhone(i, "label")}
              placeholder="label"
            />
            <input
              value={p.number}
              onChange={setPhone(i, "number")}
              placeholder="number"
              inputMode="tel"
            />
            <button
              className="row-remove"
              onClick={() =>
                setForm((f) => ({ ...f, phones: f.phones.filter((_, j) => j !== i) }))
              }
              aria-label="Remove phone"
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="add-line"
          onClick={() =>
            setForm((f) => ({ ...f, phones: [...f.phones, { label: "", number: "" }] }))
          }
        >
          + Add phone
        </button>
      </div>

      <div className="field">
        <label>Emails</label>
        {form.emails.map((e, i) => (
          <div className="multi-row" key={i}>
            <input
              value={e}
              onChange={setEmail(i)}
              placeholder="name@company.com"
              inputMode="email"
            />
            <button
              className="row-remove"
              onClick={() =>
                setForm((f) => ({ ...f, emails: f.emails.filter((_, j) => j !== i) }))
              }
              aria-label="Remove email"
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="add-line"
          onClick={() => setForm((f) => ({ ...f, emails: [...f.emails, ""] }))}
        >
          + Add email
        </button>
      </div>

      {text("website", "Website")}

      <div className={cls(form.address)}>
        <label>Address</label>
        <textarea
          rows={2}
          value={form.address}
          onChange={set("address")}
          placeholder={markUndetected ? "Not detected — add if needed" : ""}
        />
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea rows={2} value={form.notes} onChange={set("notes")} />
      </div>

      <TagEditor
        tags={form.tags}
        setTags={(next) => setForm((f) => ({ ...f, tags: next }))}
        suggestions={suggestions}
      />
    </div>
  );
}

/* ------------------------------- Tags ------------------------------------- */
function TagEditor({ tags, setTags, suggestions }) {
  const [input, setInput] = useState("");
  const has = (v) => tags.some((t) => t.toLowerCase() === v.toLowerCase());
  const add = (raw) => {
    const v = raw.trim();
    setInput("");
    if (!v || has(v)) return;
    setTags([...tags, v]);
  };
  const remove = (i) => setTags(tags.filter((_, j) => j !== i));
  const sugg = (suggestions || []).filter(
    (s) => !has(s) && (!input || s.toLowerCase().includes(input.toLowerCase())),
  );

  return (
    <div className="field">
      <label>Tags</label>
      {tags.length > 0 && (
        <div className="chips">
          {tags.map((t, i) => (
            <span className="chip on" key={i}>
              {t}
              <button onClick={() => remove(i)} aria-label="Remove tag">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(input);
          }
        }}
        placeholder="Add a tag, then Enter"
      />
      {sugg.length > 0 && (
        <div className="chips suggest">
          {sugg.slice(0, 12).map((s) => (
            <button className="chip" key={s} onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------- Image viewer -------------------------------- */
function ImageLightbox({ url, onClose }) {
  const scrollRef = useRef(null);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && zoom) {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    }
  }, [zoom]);

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="lightbox-scroll" ref={scrollRef} onClick={(e) => e.stopPropagation()}>
        <img
          className={"lightbox-img" + (zoom ? " zoom" : "")}
          src={url}
          alt="Business card"
          onClick={() => setZoom((z) => !z)}
        />
      </div>
      <div className="lightbox-hint">
        {zoom ? "Tap image to fit · tap × to close" : "Tap image to zoom · tap edge or × to close"}
      </div>
    </div>
  );
}

/* ------------------------------- Auth ------------------------------------- */
function AuthView({ flash }) {
  const [mode, setMode] = useState("in"); // in | up
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setErr("");
    if (!email || !pw) {
      setErr("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password: pw });
        if (error) throw error;
        flash("Account created. If confirmation is on, check your email.");
      }
    } catch (e) {
      setErr(e.message || "That didn’t work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="wordmark">
        <span className="seal-mark" />
        Connex
      </div>
      <p className="auth-tag">Scan a card. Keep it. Add it to Contacts.</p>

      {err && <div className="auth-err">{err}</div>}

      <div className="field">
        <label>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          inputMode="email"
          autoComplete="email"
        />
      </div>
      <div className="field">
        <label>Password</label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete={mode === "in" ? "current-password" : "new-password"}
        />
      </div>

      <button className="btn btn-primary" onClick={submit} disabled={busy}>
        {busy ? <span className="spinner" /> : mode === "in" ? "Sign in" : "Create account"}
      </button>

      <div className="auth-switch">
        <button
          className="btn-text"
          onClick={() => {
            setErr("");
            setMode(mode === "in" ? "up" : "in");
          }}
        >
          {mode === "in" ? "Need an account? Create one" : "Have an account? Sign in"}
        </button>
      </div>
      <div className="foot">Connex {APP_VERSION}</div>
    </div>
  );
}

/* ----------------------------- Fallbacks ---------------------------------- */
function CenterLoad() {
  return (
    <div className="center-load">
      <span className="spinner dark" />
    </div>
  );
}

function ConfigWarn() {
  return (
    <div className="config-warn">
      <strong>Connex isn’t connected yet.</strong>
      <p>
        Create a <code>.env</code> file from <code>.env.example</code> and set{" "}
        <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> from your
        Supabase project, then restart the dev server. See the README for the full setup.
      </p>
    </div>
  );
}
