import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc, onSnapshot, runTransaction, writeBatch } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const say = text => { $('cloud-state').textContent = text; if (!auth.currentUser) $('login-state').textContent = text; };
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const root = doc(db, 'colecciones', 'familiar');
const chromos = collection(db, 'colecciones', 'familiar', 'cromos');
const ref = id => doc(chromos, encodeURIComponent(id));
const initial = { ...window.getCloudOwned() };
const ids = Object.keys(initial);
const marker = doc(chromos, 'estado_inicial');
let unsubscribe = null;
let session = 0;
let lastCloudOwned = {};
let pending = new Map();
let saveChain = Promise.resolve();

function apply(updates) {
  window.applyCloudOwned({ ...window.getCloudOwned(), ...updates });
}

$('login-form').onsubmit = async event => {
  event.preventDefault();
  $('login-btn').disabled = true;
  const email = $('login-email').value.trim();
  const pass = $('login-pass').value;
  try {
    say('Comprobando acceso…');
    await setPersistence(auth, $('remember-session').checked ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, pass);
    $('login-pass').value = '';
  } catch (e) {
    say('No se pudo iniciar sesión: ' + e.code);
  } finally { $('login-btn').disabled = false; }
};
$('show-pass').onclick = () => { const p = $('login-pass'); p.type = p.type === 'password' ? 'text' : 'password'; $('show-pass').textContent = p.type === 'password' ? 'Ver' : 'Ocultar'; };
$('reset-pass').onclick = async () => { const email = $('login-email'); if (!email.reportValidity()) return; try { await sendPasswordResetEmail(auth, email.value.trim()); say('Si el correo está registrado, recibirás instrucciones para restablecer la contraseña.'); } catch(e) { say('No se pudo solicitar la recuperación: ' + e.code); } };
$('logout-btn').onclick = async () => { try { await saveChain; await signOut(auth); } catch(e) { say('No se pudo cerrar sesión: ' + e.code); } };

async function initializeIfNeeded(ticket) {
  const seed = await getDoc(marker);
  if (seed.exists()) return;
  say('Preparando los cromos iniciales…');
  // No se escribe el marcador hasta haber creado todos los documentos.
  // Las transacciones no sobrescriben cromos ya guardados por el otro usuario.
  for (let i = 0; i < ids.length; i++) {
    if (ticket !== session) return;
    const id = ids[i];
    await runTransaction(db, async tx => {
      const r = ref(id);
      const snap = await tx.get(r);
      if (!snap.exists()) tx.set(r, { owned: !!initial[id], updatedAt: Date.now() });
    });
    if ((i + 1) % 50 === 0) say('Preparando cromos: ' + (i + 1) + '/' + ids.length);
  }
  if (ticket === session) await setDoc(marker, { completed: true, updatedAt: Date.now() });
}

onAuthStateChanged(auth, async user => {
  const ticket = ++session;
  window.cloudReady = false;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  pending.clear();
  lastCloudOwned = {};
  $('auth-loading').hidden = true;
  $('login-panel').hidden = !!user;
  $('app-shell').hidden = !user;
  $('login-state').textContent = '';
  $('login-pass').value = ''; 
  $('logout-btn').hidden = !user;
  if (!user) {
    say('Inicia sesión para consultar y guardar los cromos compartidos.');
    return;
  }
  say('Conectando con la colección…');
  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(root);
      if (!snap.exists()) tx.set(root, { initialized: true, createdAt: Date.now() });
    });
    if (ticket !== session) return;
    await initializeIfNeeded(ticket);
    if (ticket !== session) return;
    unsubscribe = onSnapshot(chromos, snap => {
      const next = {};
      snap.forEach(d => {
        if (d.id === 'estado_inicial') return;
        try { next[decodeURIComponent(d.id)] = !!d.data().owned; } catch (_) {}
      });
      lastCloudOwned = { ...next };
      // No reemplazar marcas locales pendientes de confirmación.
      for (const [id, value] of pending) next[id] = value;
      apply(next);
      window.cloudReady = true;
      say(pending.size ? 'Guardando cambios…' : '✓ Sincronizado · cambios guardados en la nube');
    }, e => {
      window.cloudReady = false;
      say('Error de sincronización: ' + e.code);
    });
  } catch (e) {
    say('No se pudo conectar: ' + e.code + ' ' + e.message);
  }
});

window.cloudSave = owned => {
  if (!auth.currentUser || !window.cloudReady) {
    say('Sin conexión: no se ha guardado el cambio.');
    return;
  }
  const changes = ids.filter(id =>
    !!owned[id] !== (pending.has(id) ? pending.get(id) : !!lastCloudOwned[id])
  );
  if (!changes.length) return;
  for (const id of changes) pending.set(id, !!owned[id]);
  say('Guardando cambios…');
  const ticket = session;
  saveChain = saveChain.catch(() => {}).then(async () => {
    if (ticket !== session || !auth.currentUser) return;
    const batch = writeBatch(db);
    const values = new Map(pending);
    for (const [id, value] of values) {
      batch.set(ref(id), { owned: value, updatedAt: Date.now() }, { merge: true });
    }
    if (!values.size) return;
    try {
      await batch.commit();
      if (ticket !== session) return;
      for (const [id, value] of values) {
        if (pending.get(id) === value) pending.delete(id);
        lastCloudOwned[id] = value;
      }
      say(pending.size ? 'Guardando cambios…' : '✓ Cambios guardados en la nube');
    } catch (e) {
      say('Error al guardar: ' + e.code);
    }
  });
};
