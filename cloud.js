import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, runTransaction } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
const $=id=>document.getElementById(id), say=t=>$('cloud-state').textContent=t;
const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
const root=doc(db,'colecciones','familiar');
const ref=id=>doc(db,'colecciones','familiar','cromos',encodeURIComponent(id));
const ids=Object.keys(window.getCloudOwned());
let unsub=null,session=0,loading=false;
const initial=window.getCloudOwned();
function apply(updates){const merged={...window.getCloudOwned(),...updates};window.applyCloudOwned(merged)}
$('login-btn').onclick=async()=>{const email=$('login-email').value.trim(),pass=$('login-pass').value;try{say('Comprobando acceso…');await signInWithEmailAndPassword(auth,email,pass);$('login-pass').value=''}catch(e){say('No se pudo iniciar sesión: '+e.code)}};
$('logout-btn').onclick=()=>signOut(auth);
onAuthStateChanged(auth,async user=>{
 const ticket=++session;window.cloudReady=false;if(unsub){unsub();unsub=null}
 $('login-panel').hidden=!!user;$('logout-btn').hidden=!user;
 if(!user){say('Inicia sesión para consultar y guardar los cromos compartidos.');return}
 say('Conectando con la colección…');
 try{
   // Solo el primer usuario inicializa los datos; la transacción impide que dos usuarios los sobrescriban.
   await runTransaction(db,async tx=>{const snap=await tx.get(root);if(!snap.exists())tx.set(root,{initialized:true,createdAt:Date.now()})});
   if(ticket!==session)return;
   // Los cromos no existentes se inicializan con el estado provisional de las fotos.
   // Evitar escritura masiva simultánea: se inicializa una vez por usuario con marcador de control.
   const marker=doc(db,'colecciones','familiar','cromos','__seed__');
   const seed=await getDoc(marker);
   if(!seed.exists()){
     say('Preparando los cromos iniciales…');
     // Cada transacción individual respeta un cambio concurrente y evita sobrescribir cromos ya existentes.
     for(let i=0;i<ids.length;i++){
       if(ticket!==session)return;
       const id=ids[i];const r=ref(id);
       await runTransaction(db,async tx=>{const snap=await tx.get(r);if(!snap.exists())tx.set(r,{owned:!!initial[id],updatedAt:Date.now()})});
       if(i%50===0)say('Preparando cromos: '+(i+1)+'/'+ids.length);
     }
     await setDoc(marker,{completed:true,updatedAt:Date.now()});
   }
   if(ticket!==session)return;
   const cache={};const unsubs=[];let received=0;
   // Escuchar cambios en cada cromo; permite cambios concurrentes sin pisar otros cromos.
   // Un único listener de colección es más eficiente que cientos de listeners individuales.
   const {collection,onSnapshot:listen}=await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js');
   const c=collection(db,'colecciones','familiar','cromos');
   unsub=listen(c,snap=>{
     const next={};snap.forEach(d=>{if(d.id!=='__seed__'){try{next[decodeURIComponent(d.id)]=!!d.data().owned}catch(e){}}});
     apply(next);window.__lastCloudOwned={...window.getCloudOwned()};window.cloudReady=true;say('✓ Sincronizado · los cambios se guardan en la nube');
   },e=>{window.cloudReady=false;say('Error de sincronización: '+e.code)});
 }catch(e){say('No se pudo conectar: '+e.code+' '+e.message)}
});
window.cloudSave=async owned=>{if(!window.cloudReady)return;window.cloudReady=false;say('Guardando cambios…');try{
 const previous=window.__lastCloudOwned||{};
 const changed=ids.filter(id=>previous[id]!==owned[id]);
 // Solo persistir cambios desde la interfaz, no reescribir toda la colección.
 await Promise.all(changed.map(id=>setDoc(ref(id),{owned:!!owned[id],updatedAt:Date.now()},{merge:true})));
 window.__lastCloudOwned={...owned};window.cloudReady=true;say('✓ Cambios guardados en la nube');
}catch(e){window.cloudReady=true;say('Error al guardar: '+e.code)}};
