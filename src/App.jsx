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
const APP_VERSION = "v2026:06:20-00:40";

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
  };
}

export default function App() {
  if (!isConfigured) return <ConfigWarn />;

  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  const [cards, setCards] = useState([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [query, setQuery] = useState("");

  const [view, setView] = useState("list"); // list | review | detail
  const [captured, setCaptured] = useState(null); // {dataUrl, blob, base64, mediaType, rawFields, model}
  const [form, setForm] = useState(BLANK);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);

  const [current, setCurrent] = useState(null); // card open in detail
  const [editing, setEditing] = useState(false);

  const [toast, setToast] = useState(null);
  const [stamp, setStamp] = useState(false);

  const fileRef = useRef(null);

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

  // --- capture + scan -------------------------------------------------------
  function startScan() {
    fileRef.current?.click();
  }

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const img = await processImage(file);
      setCaptured({ ...img, rawFields: null, model: null });
      setForm(BLANK);
      setView("review");
      setScanning(true);
      try {
        const { fields, model_used } = await scanCard(img.base64, img.mediaType);
        setForm(fieldsToForm(fields));
        setCaptured((c) => ({ ...c, rawFields: fields, model: model_used }));
      } catch (err) {
        flash(err.message || "Couldn’t read the card — you can type it in.");
      } finally {
        setScanning(false);
      }
    } catch {
      flash("That image couldn’t be opened.");
    }
  }

  async function saveCard() {
    if (!session) return;
    setSaving(true);
    try {
      const path = await uploadImage(session.user.id, captured.blob);
      const rec = {
        ...formToRecord(form),
        user_id: session.user.id,
        image_path: path,
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
    setEditing(false);
    setView("detail");
  }

  async function saveEdits() {
    setSaving(true);
    try {
      const updated = await updateCard(current.id, formToRecord(form));
      setCards((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
      setCurrent(updated);
      setEditing(false);
      flash("Changes saved.");
    } catch (e) {
      flash(e.message || "Couldn’t save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function removeCard() {
    if (!window.confirm("Delete this card and its photo? This can’t be undone.")) return;
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
      flash("Review the contact, then tap Create New Contact to save it.", 5200);
    else flash("Contact card saved — open the .vcf to add it to Contacts.", 5200);
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
          onOpen={openDetail}
          onSignOut={() => supabase.auth.signOut()}
        />
      )}

      {view === "review" && (
        <ReviewView
          captured={captured}
          form={form}
          setForm={setForm}
          scanning={scanning}
          saving={saving}
          onSave={saveCard}
          onRetake={startScan}
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
          editing={editing}
          setEditing={setEditing}
          saving={saving}
          onSaveEdits={saveEdits}
          onDelete={removeCard}
          onBack={() => {
            setEditing(false);
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

/* ------------------------------- List ------------------------------------- */
function ListView({ cards, loading, query, setQuery, onOpen, onSignOut }) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) =>
      [c.full_name, c.company, c.job_title, ...(c.emails || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [cards, query]);

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
          <input
            className="search"
            placeholder="Search name, company, email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {loading && cards.length === 0 ? (
          <div className="card-list">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="seal-big" />
            <h2>{cards.length === 0 ? "No cards yet" : "No matches"}</h2>
            <p>
              {cards.length === 0
                ? "Tap Scan a card to capture your first one."
                : "Try a different name or company."}
            </p>
          </div>
        ) : (
          <div className="card-list">
            {filtered.map((c) => (
              <button key={c.id} className="tile" onClick={() => onOpen(c)}>
                <Thumb card={c} />
                <div className="tile-body">
                  <div className="tile-name">{c.full_name || "Unnamed contact"}</div>
                  <div className="tile-sub">
                    {[c.job_title, c.company].filter(Boolean).join(" · ") || "—"}
                  </div>
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
  scanning,
  saving,
  onSave,
  onRetake,
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

      {captured?.dataUrl && (
        <div className="shot-wrap">
          <img className="shot" src={captured.dataUrl} alt="Captured business card" />
        </div>
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

      <CardForm form={form} setForm={setForm} markUndetected />

      <div className="stack">
        <button className="btn btn-primary" onClick={onSave} disabled={saving || scanning}>
          {saving ? <span className="spinner" /> : "Save card"}
        </button>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={onRetake} disabled={saving}>
            Retake
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
  editing,
  setEditing,
  saving,
  onSaveEdits,
  onDelete,
  onBack,
  onAddToContacts,
}) {
  const [imgUrl, setImgUrl] = useState(null);
  useEffect(() => {
    let on = true;
    if (card.image_path) signedUrl(card.image_path).then((u) => on && setImgUrl(u));
    return () => {
      on = false;
    };
  }, [card.image_path]);

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

      {imgUrl && (
        <div className="shot-wrap">
          <img className="shot" src={imgUrl} alt="Saved business card" />
        </div>
      )}

      {editing ? (
        <>
          <CardForm form={form} setForm={setForm} />
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
function CardForm({ form, setForm, markUndetected = false }) {
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
