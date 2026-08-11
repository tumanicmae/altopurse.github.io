/* ============================================================
   Firestore, with a read-only fallback.

   If no service account is configured the API still serves the
   catalogue straight from the repo's data/*.json. That means Mollie
   checkout can be tested before Firestore exists — writes just fail
   loudly instead of silently pretending to work.
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');

let firestore = null;
export let usingFirestore = false;

export async function initDb() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (!raw) {
    console.warn('[db] No service account set — serving the repo JSON read-only.');
    return;
  }

  try {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const creds = JSON.parse(raw);
    initializeApp({
      credential: cert(creds),
      projectId: process.env.FIRESTORE_PROJECT_ID || creds.project_id
    });
    firestore = getFirestore();
    usingFirestore = true;
    console.log('[db] Firestore connected.');
  } catch (err) {
    console.error('[db] Firestore init failed, falling back to repo JSON:', err.message);
  }
}

export function db() {
  if (!firestore) throw new Error('Firestore is not configured on this server.');
  return firestore;
}

async function localJson(name) {
  return JSON.parse(await readFile(join(dataDir, name), 'utf8'));
}

/* ── Catalogue reads ──────────────────────────────────────── */

export async function getArtworks() {
  if (!usingFirestore) return (await localJson('artworks.json')).artworks ?? [];
  const snap = await firestore.collection('artworks').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getMerch() {
  if (!usingFirestore) return (await localJson('merch.json')).products ?? [];
  const snap = await firestore.collection('merch').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getReleases() {
  if (!usingFirestore) return await localJson('releases.json');
  const doc = await firestore.collection('meta').doc('releases').get();
  if (!doc.exists) return await localJson('releases.json');
  return doc.data();
}

export async function saveReleases(payload) {
  if (!usingFirestore) throw new Error('Cannot save releases without Firestore.');
  await firestore.collection('meta').doc('releases').set(payload);
}

/* ── Orders ───────────────────────────────────────────────── */

export async function createOrder(order) {
  if (!usingFirestore) throw new Error('Cannot take orders without Firestore.');
  const ref = await firestore.collection('orders').add(order);
  return ref.id;
}

export async function updateOrder(id, patch) {
  if (!usingFirestore) throw new Error('Cannot update orders without Firestore.');
  await firestore.collection('orders').doc(id).set(patch, { merge: true });
}

export async function getOrder(id) {
  if (!usingFirestore) return null;
  const doc = await firestore.collection('orders').doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function listOrders({ limit = 50 } = {}) {
  if (!usingFirestore) return [];
  const snap = await firestore.collection('orders')
    .orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ── Reports: bugs and feature requests from the team ─────── */

/**
 * Pictures are stored as data URLs on the document itself rather than in
 * Firebase Storage. Storage would mean another product to configure, another
 * set of rules to get wrong, and signed URLs to manage — for a handful of
 * screenshots between two people. A Firestore document caps at 1 MB, so the
 * browser resizes and re-encodes before sending, and the API refuses anything
 * still too big rather than letting Firestore reject it with a worse message.
 *
 * That cap is also the ceiling on quality: several pictures in one report
 * share the megabyte between them. Sending artwork at full resolution would
 * mean moving to Storage.
 */
export async function createReport(report) {
  if (!usingFirestore) throw new Error('Cannot save reports without Firestore.');
  const ref = await firestore.collection('reports').add(report);
  return ref.id;
}

export async function listReports({ limit = 50 } = {}) {
  if (!usingFirestore) return [];
  const snap = await firestore.collection('reports')
    .orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function updateReport(id, patch) {
  if (!usingFirestore) throw new Error('Cannot update reports without Firestore.');
  await firestore.collection('reports').doc(id).set(patch, { merge: true });
}

export async function deleteReport(id) {
  if (!usingFirestore) throw new Error('Cannot delete reports without Firestore.');
  await firestore.collection('reports').doc(id).delete();
}

/**
 * Erasure request handling. UK tax rules mean a sale record has to survive
 * for six years, so the transaction stays and only the person is removed.
 * Deleting the whole order would trade one legal problem for another.
 */
export async function anonymiseOrder(id) {
  if (!usingFirestore) throw new Error('Cannot edit orders without Firestore.');
  await firestore.collection('orders').doc(id).set({
    buyer: {
      name: '[erased]', email: '[erased]', address: '[erased]',
      postcode: '[erased]', country: '[erased]'
    },
    anonymisedAt: new Date().toISOString()
  }, { merge: true });
}

/**
 * Mark an order paid and, if it was a one-of-one, mark the original sold —
 * both in a single transaction so two simultaneous payments cannot both win.
 * Safe to call repeatedly: Mollie retries webhooks.
 */
export async function settleOrder(orderId, { paymentStatus, item }) {
  if (!usingFirestore) throw new Error('Cannot settle orders without Firestore.');

  await firestore.runTransaction(async (tx) => {
    const orderRef = firestore.collection('orders').doc(orderId);
    const orderDoc = await tx.get(orderRef);
    if (!orderDoc.exists) throw new Error(`Order ${orderId} is missing.`);
    if (orderDoc.data().status === 'paid') return; // already settled

    let artRef = null;
    let artDoc = null;
    if (paymentStatus === 'paid' && item?.unique && item.artworkId) {
      artRef = firestore.collection('artworks').doc(item.artworkId);
      artDoc = await tx.get(artRef); // every read must precede every write
    }

    tx.set(orderRef, {
      status: paymentStatus,
      settledAt: new Date().toISOString()
    }, { merge: true });

    if (artRef && artDoc?.exists) {
      tx.set(artRef, {
        original: { ...(artDoc.data().original ?? {}), available: false, soldAt: new Date().toISOString() }
      }, { merge: true });
    }
  });
}
