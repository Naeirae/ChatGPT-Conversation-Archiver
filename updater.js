const REPO='Naeirae/ChatGPT-Conversation-Archiver';
const BRANCH='main';
const API_TREE='https://api.github.com/repos/'+REPO+'/git/trees/'+BRANCH+'?recursive=1';
const RAW_ROOT='https://raw.githubusercontent.com/'+REPO+'/'+BRANCH+'/';
const DB_NAME='chatgpt-archiver-updater';
const STORE_NAME='handles';
const ROOT_KEY='extension-root';
const $=id=>document.getElementById(id);
const logLines=[];
let rootHandle=null;
let busy=false;

function stamp(){return new Date().toLocaleTimeString('ru-RU')}
function log(message=''){logLines.push('['+stamp()+'] '+message);$('log').textContent=logLines.join('\n');$('log').scrollTop=$('log').scrollHeight}
function setStatus(message,kind=''){$('status').textContent=message;$('status').className='status'+(kind?' '+kind:'')}
function setBusy(value){busy=Boolean(value);for(const id of ['chooseFolder','forgetFolder','checkUpdate','runUpdate','reloadExtension'])$(id).disabled=busy}

function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE_NAME))db.createObjectStore(STORE_NAME)};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
async function saveHandle(handle){const db=await openDb();await new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readwrite');tx.objectStore(STORE_NAME).put(handle,ROOT_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}
async function loadHandle(){const db=await openDb();const handle=await new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readonly');const req=tx.objectStore(STORE_NAME).get(ROOT_KEY);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)});db.close();return handle}
async function forgetHandle(){const db=await openDb();await new Promise((resolve,reject)=>{const tx=db.transaction(STORE_NAME,'readwrite');tx.objectStore(STORE_NAME).delete(ROOT_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}

async function ensurePermission(handle,request=false){if(!handle)return false;if(typeof handle.queryPermission==='function'&&(await handle.queryPermission({mode:'readwrite'}))==='granted')return true;if(request&&typeof handle.requestPermission==='function')return(await handle.requestPermission({mode:'readwrite'}))==='granted';return false}
async function getDirectory(root,parts,create=false){let current=root;for(const part of parts)current=await current.getDirectoryHandle(part,{create});return current}
async function getFileHandleByPath(root,path,create=false){const parts=path.split('/').filter(Boolean);const name=parts.pop();const dir=await getDirectory(root,parts,create);return dir.getFileHandle(name,{create})}
async function readBytes(root,path){try{const handle=await getFileHandleByPath(root,path,false);const file=await handle.getFile();return new Uint8Array(await file.arrayBuffer())}catch(error){if(error?.name==='NotFoundError')return null;throw error}}
async function readText(root,path){const bytes=await readBytes(root,path);return bytes?new TextDecoder().decode(bytes):''}
async function writeBytes(root,path,bytes){const handle=await getFileHandleByPath(root,path,true);const writable=await handle.createWritable();await writable.write(bytes);await writable.close()}

async function verifyInstallRoot(root){const text=await readText(root,'manifest.json');if(!text)throw new Error('В выбранной папке нет manifest.json.');let manifest;try{manifest=JSON.parse(text)}catch(_){throw new Error('manifest.json в выбранной папке повреждён.')}const correctName=manifest?.name==='Архиватор ChatGPT';const correctHome=String(manifest?.homepage_url||'').includes(REPO);if(!correctName&&!correctHome)throw new Error('Это не папка установленного ChatGPT Archiver.');return manifest}

async function chooseFolder(){if(typeof window.showDirectoryPicker!=='function'){$('fallback').classList.remove('hidden');throw new Error('Встроенный выбор папки недоступен. Используйте update.cmd.')}const handle=await window.showDirectoryPicker({id:'chatgpt-archiver-root',mode:'readwrite',startIn:'downloads'});if(!(await ensurePermission(handle,true)))throw new Error('Нет разрешения на запись в выбранную папку.');await verifyInstallRoot(handle);rootHandle=handle;await saveHandle(handle);await refreshFolderState();log('Выбрана папка: '+handle.name);return handle}
async function ensureRoot(requestPermission=false){if(!rootHandle){try{rootHandle=await loadHandle()}catch(_){}}if(!rootHandle)return null;if(!(await ensurePermission(rootHandle,requestPermission)))return null;await verifyInstallRoot(rootHandle);return rootHandle}
async function refreshFolderState(){if(!rootHandle){$('folderState').textContent='Папка пока не выбрана.';$('diskVersion').textContent='—';return}try{const permission=await ensurePermission(rootHandle,false);$('folderState').textContent=permission?'Выбрана: '+rootHandle.name:'Сохранена: '+rootHandle.name+' · нужно снова разрешить запись.';const manifest=permission?await verifyInstallRoot(rootHandle):null;$('diskVersion').textContent=manifest?.version||'нужно разрешение'}catch(error){$('folderState').textContent='Сохранённая папка недоступна: '+(error.message||String(error));$('diskVersion').textContent='—'}}

async function fetchJson(url){const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/vnd.github+json'}});if(!response.ok)throw new Error('GitHub ответил '+response.status+'.');return response.json()}
async function fetchRemoteManifest(){const response=await fetch(RAW_ROOT+'manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('Не удалось прочитать manifest.json с GitHub: '+response.status);const manifest=await response.json();$('remoteVersion').textContent=manifest.version||'—';return manifest}
function rawUrl(path){return RAW_ROOT+path.split('/').map(encodeURIComponent).join('/')}
async function fetchRaw(path){const response=await fetch(rawUrl(path),{cache:'no-store'});if(!response.ok)throw new Error('Не удалось скачать '+path+': HTTP '+response.status);return new Uint8Array(await response.arrayBuffer())}
function concatBytes(a,b){const out=new Uint8Array(a.length+b.length);out.set(a,0);out.set(b,a.length);return out}
async function gitBlobSha(bytes){const header=new TextEncoder().encode('blob '+bytes.byteLength+'\0');const digest=await crypto.subtle.digest('SHA-1',concatBytes(header,bytes));return[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')}
function backupStamp(){const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())}

async function persistLog(){if(!rootHandle||!(await ensurePermission(rootHandle,false)))return;try{await writeBytes(rootHandle,'updater-browser-last.log',new TextEncoder().encode(logLines.join('\r\n')+'\r\n'))}catch(_){}}
async function buildPlan(root,remoteFiles){const changed=[];for(let i=0;i<remoteFiles.length;i++){const item=remoteFiles[i];const local=await readBytes(root,item.path);if(!local){changed.push({...item,exists:false,local:null})}else if((await gitBlobSha(local))!==item.sha){changed.push({...item,exists:true,local})}if((i+1)%10===0||i===remoteFiles.length-1)setStatus('Проверяю локальные файлы: '+(i+1)+' / '+remoteFiles.length)}return changed}

async function checkUpdate(){setBusy(true);try{const remote=await fetchRemoteManifest();const root=await ensureRoot(false);if(!root){setStatus('На GitHub версия '+remote.version+'. Выберите папку расширения для сравнения файлов.');log('GitHub: '+remote.version);return}const local=await verifyInstallRoot(root);$('diskVersion').textContent=local.version||'—';setStatus(String(local.version)===String(remote.version)?'Версия совпадает: '+local.version+'. Для проверки файлов нажмите «Обновить».':'Доступно обновление: '+local.version+' → '+remote.version+'.',String(local.version)===String(remote.version)?'success':'');log('Проверка версий: локально '+local.version+', GitHub '+remote.version+'.')}catch(error){setStatus(error.message||String(error),'error');log('ОШИБКА: '+(error.message||String(error)))}finally{setBusy(false)}}

async function runUpdate(){setBusy(true);try{if(!rootHandle)await chooseFolder();const root=await ensureRoot(true);if(!root)throw new Error('Нужно разрешить запись в папку расширения.');const local=await verifyInstallRoot(root);const remote=await fetchRemoteManifest();log('Запуск обновления: '+local.version+' → '+remote.version);setStatus('Читаю список файлов репозитория…');const tree=await fetchJson(API_TREE);if(tree.truncated)throw new Error('GitHub вернул неполное дерево репозитория.');const remoteFiles=(tree.tree||[]).filter(item=>item.type==='blob'&&item.path);log('Файлов в репозитории: '+remoteFiles.length);const changed=await buildPlan(root,remoteFiles);if(!changed.length){setStatus('Уже установлена актуальная копия. Изменённых файлов нет.','success');log('Изменённых файлов нет.');await persistLog();return}

log('Изменить файлов: '+changed.length+'. Сначала скачиваю всё во временную память.');const downloads=[];for(let i=0;i<changed.length;i++){const item=changed[i];setStatus('Скачиваю обновление: '+(i+1)+' / '+changed.length);downloads.push({item,bytes:await fetchRaw(item.path)});log('Скачан: '+item.path)}

const existing=downloads.filter(entry=>entry.item.exists);let backupPrefix='';if(existing.length){backupPrefix='.archiver-update-backup/browser-'+backupStamp();log('Резервная копия: '+backupPrefix);for(const entry of existing)await writeBytes(root,backupPrefix+'/'+entry.item.path,entry.item.local)}

for(let i=0;i<downloads.length;i++){setStatus('Записываю файлы: '+(i+1)+' / '+downloads.length);const entry=downloads[i];await writeBytes(root,entry.item.path,entry.bytes);log('Обновлён: '+entry.item.path)}

const finalManifest=await verifyInstallRoot(root);$('diskVersion').textContent=finalManifest.version||remote.version||'—';setStatus('Файлы обновлены до '+(finalManifest.version||remote.version)+'. Нажмите «Перезагрузить расширение».','success');log('Готово. Версия файлов: '+(finalManifest.version||remote.version)+'.');if(backupPrefix)log('Резервная копия: '+backupPrefix);await persistLog()}catch(error){const message=error.message||String(error);setStatus(message,'error');log('ОШИБКА: '+message);await persistLog()}finally{setBusy(false)}}

$('chooseFolder').onclick=async()=>{setBusy(true);try{await chooseFolder();setStatus('Папка выбрана. Можно обновлять.','success')}catch(error){setStatus(error.message||String(error),'error');log('ОШИБКА: '+(error.message||String(error)))}finally{setBusy(false)}};
$('forgetFolder').onclick=async()=>{await forgetHandle().catch(()=>{});rootHandle=null;await refreshFolderState();log('Сохранённый выбор папки удалён.')};
$('checkUpdate').onclick=checkUpdate;
$('runUpdate').onclick=runUpdate;
$('reloadExtension').onclick=()=>{setStatus('Перезагружаю расширение…');setTimeout(()=>chrome.runtime.reload(),120)};
$('copyLog').onclick=async()=>{await navigator.clipboard.writeText(logLines.join('\n'));setStatus('Лог скопирован.','success')};

(async()=>{$('loadedVersion').textContent=chrome.runtime.getManifest().version||'—';if(typeof window.showDirectoryPicker!=='function')$('fallback').classList.remove('hidden');try{rootHandle=await loadHandle()}catch(_){}await refreshFolderState();try{await fetchRemoteManifest();log('Страница обновления готова.')}catch(error){setStatus('Не удалось проверить GitHub: '+(error.message||String(error)),'error');log('ОШИБКА GitHub: '+(error.message||String(error)))}})();
