import { supabase } from "./supabaseClient.js";

// ---------------------------------------------------------------------------
// Image processing: downscale + re-encode to JPEG before upload/extraction.
// Keeps storage small and the model payload cheap, while staying legible.
// EXIF orientation is applied so portrait photos are not sideways.
// ---------------------------------------------------------------------------
export async function processImage(file, maxEdge = 1600, quality = 0.85) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await loadViaImage(file); // Safari fallback (applies EXIF on draw)
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.split(",")[1];
  const blob = await new Promise((res) =>
    canvas.toBlob(res, "image/jpeg", quality),
  );

  return { blob, dataUrl, base64, mediaType: "image/jpeg", width: w, height: h };
}

function loadViaImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Extraction via the Edge Function (Anthropic key stays server-side).
// Returns { fields, model_used }. Throws a human-readable Error on failure.
// ---------------------------------------------------------------------------
export async function scanCard(base64, mediaType) {
  const { data, error } = await supabase.functions.invoke("scan-card", {
    body: { image_base64: base64, media_type: mediaType },
  });
  if (error) {
    let msg = "Couldn’t read the card. Check your connection and try again.";
    try {
      const body = await error.context?.json?.();
      if (body?.error) msg = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Cards CRUD
// ---------------------------------------------------------------------------
export async function listCards() {
  const { data, error } = await supabase
    .from("cards")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function insertCard(record) {
  const { data, error } = await supabase
    .from("cards")
    .insert(record)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCard(id, patch) {
  const { data, error } = await supabase
    .from("cards")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCard(card) {
  const paths = [card.image_path, card.image_path_back].filter(Boolean);
  if (paths.length) {
    await supabase.storage.from("card-images").remove(paths);
  }
  const { error } = await supabase.from("cards").delete().eq("id", card.id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Storage: upload card photo, fetch a short-lived signed URL to display it.
// ---------------------------------------------------------------------------
export async function uploadImage(userId, blob) {
  const path = `${userId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage
    .from("card-images")
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  return path;
}

export async function signedUrl(path, expiresIn = 3600) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from("card-images")
    .createSignedUrl(path, expiresIn);
  if (error) return null;
  return data?.signedUrl ?? null;
}
