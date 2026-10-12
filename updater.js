const REPO='Naeirae/ChatGPT-Conversation-Archiver';
const BRANCH='main';
const API_COMMITS='https://api.github.com/repos/'+REPO+'/commits/';
const API_TREES='https://api.github.com/repos/'+REPO+'/git/trees/';
const API_BLOBS='https://api.github.com/repos/'+REPO+'/git/blobs/';
const MANAGED_FILES=new Set([
  'manifest.json','service-worker.js','content-chatgpt.js',
  'popup.html','popup.css','popup.js',
  'help.html','help.css',
  'updater.html','updater.css','updater.js',
  'planner.html','planner.css','planner.js',
  'offscreen.html','offscreen.js',
  'update.cmd','update.ps1','Update ChatGPT Archiver.vbs'
]);
function isManagedPath(path=''){return MANAGED_FILES.has(path)||path.startsWith('icons/')||path.startsWith('lib/')}
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
async function refreshFolderState(){if(!rootHandle){$('folderState').textContent='Папка пока не выбрана.';$('diskVersion').textContent='—';return null}try{const permission=await ensurePermission(rootHandle,false);$('folderState').textContent=permission?'Выбрана: '+rootHandle.name:'Сохранена: '+rootHandle.name+' · нужно снова разрешить запись.';const manifest=permission?await verifyInstallRoot(rootHandle):null;$('diskVersion').textContent=manifest?.version||'нужно разрешение';if(manifest?.version){const loaded=chrome.runtime.getManifest().version||'—';if(String(loaded)!==String(manifest.version)){setStatus('В папке версия '+manifest.version+', но Chrome сейчас загрузил '+loaded+'. Перезагрузите расширение; если версия не изменится, Chrome использует другую папку.','error');log('Несовпадение: загружено '+loaded+', в выбранной папке '+manifest.version+'.')}}return manifest}catch(error){$('folderState').textContent='Сохранённая папка недоступна: '+(error.message||String(error));$('diskVersion').textContent='—';return null}}

async function fetchJson(url){const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/vnd.github+json'}});if(!response.ok)throw new Error('GitHub ответил '+response.status+'.');return response.json()}
function decodeBase64Bytes(content=''){const binary=atob(String(content||'').replace(/\s/g,''));const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes}
async function fetchRepositorySnapshot(){const commit=await fetchJson(API_COMMITS+encodeURIComponent(BRANCH)+'?check='+Date.now());const commitSha=String(commit?.sha||'');const treeSha=String(commit?.commit?.tree?.sha||'');if(!commitSha||!treeSha)throw new Error('GitHub API не вернул commit/tree SHA ветки '+BRANCH+'.');const tree=await fetchJson(API_TREES+encodeURIComponent(treeSha)+'?recursive=1&check='+Date.now());if(tree.truncated)throw new Error('GitHub вернул неполное дерево репозитория.');const files=(tree.tree||[]).filter(item=>item.type==='blob'&&item.path&&isManagedPath(item.path));const manifestItem=files.find(item=>item.path==='manifest.json');if(!manifestItem)throw new Error('В snapshot GitHub нет manifest.json.');const manifestBytes=await fetchBlob(manifestItem);const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));$('remoteVersion').textContent=manifest.version||'—';return{commitSha,treeSha,files,manifest}}
async function fetchBlob(item){if(!item?.sha)throw new Error('У файла '+(item?.path||'—')+' нет Git blob SHA.');const payload=await fetchJson(API_BLOBS+encodeURIComponent(item.sha)+'?check='+Date.now());if(!payload?.content||payload.encoding!=='base64')throw new Error('GitHub API не вернул содержимое '+item.path+'.');const bytes=decodeBase64Bytes(payload.content);const actualSha=await gitBlobSha(bytes);if(actualSha!==item.sha)throw new Error('Контрольная сумма '+item.path+' не совпала с деревом GitHub.');return bytes}
function concatBytes(a,b){const out=new Uint8Array(a.length+b.length);out.set(a,0);out.set(b,a.length);return out}
async function gitBlobSha(bytes){const header=new TextEncoder().encode('blob '+bytes.byteLength+'\0');const digest=await crypto.subtle.digest('SHA-1',concatBytes(header,bytes));return[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')}
function backupStamp(){const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())}

async function persistLog(){if(!rootHandle||!(await ensurePermission(rootHandle,false)))return;try{await writeBytes(rootHandle,'updater-browser-last.log',new TextEncoder().encode(logLines.join('\r\n')+'\r\n'))}catch(_){}}
async function buildPlan(root,remoteFiles){const changed=[];for(let i=0;i<remoteFiles.length;i++){const item=remoteFiles[i];const local=await readBytes(root,item.path);if(!local){changed.push({...item,exists:false,local:null})}else if((await gitBlobSha(local))!==item.sha){changed.push({...item,exists:true,local})}if((i+1)%10===0||i===remoteFiles.length-1)setStatus('Проверяю локальные файлы: '+(i+1)+' / '+remoteFiles.length)}return changed}

async function checkUpdate(){setBusy(true);try{const snapshot=await fetchRepositorySnapshot();const remote=snapshot.manifest;const root=await ensureRoot(false);if(!root){setStatus('На GitHub версия '+remote.version+'. Выберите папку расширения для сравнения файлов.');log('GitHub: '+remote.version+' · commit '+snapshot.commitSha.slice(0,12));return}const local=await verifyInstallRoot(root);$('diskVersion').textContent=local.version||'—';setStatus(String(local.version)===String(remote.version)?'Версия совпадает: '+local.version+'. Для проверки файлов нажмите «Обновить».':'Доступно обновление: '+local.version+' → '+remote.version+'.',String(local.version)===String(remote.version)?'success':'');log('Проверка версий: локально '+local.version+', GitHub '+remote.version+' · commit '+snapshot.commitSha.slice(0,12)+'.')}catch(error){setStatus(error.message||String(error),'error');log('ОШИБКА: '+(error.message||String(error)))}finally{setBusy(false)}}

async function runUpdate(){
  setBusy(true);
  try{
    if(!rootHandle)await chooseFolder();
    const root=await ensureRoot(true);
    if(!root)throw new Error('Нужно разрешить запись в папку расширения.');

    const local=await verifyInstallRoot(root);
    const snapshot=await fetchRepositorySnapshot();
    const remote=snapshot.manifest;
    const remoteFiles=snapshot.files;

    log('Запуск обновления: '+local.version+' → '+remote.version+' · commit '+snapshot.commitSha.slice(0,12));
    setStatus('Сверяю файлы с commit '+snapshot.commitSha.slice(0,12)+'…');

    const changed=await buildPlan(root,remoteFiles);
    if(!changed.length){
      setStatus('Уже установлена актуальная копия '+remote.version+'. Изменённых файлов нет.','success');
      log('Изменённых файлов нет.');
      await persistLog();
      return;
    }

    // Keep manifest last: Chrome must never see a new version number before
    // all runtime files have been written and verified.
    changed.sort((a,b)=>{
      if(a.path==='manifest.json')return 1;
      if(b.path==='manifest.json')return -1;
      return a.path.localeCompare(b.path);
    });

    log('Изменить файлов: '+changed.length+'. Сначала скачиваю snapshot целиком во временную память.');
    const downloads=[];
    for(let i=0;i<changed.length;i++){
      const item=changed[i];
      setStatus('Скачиваю '+(i+1)+' / '+changed.length+': '+item.path);
      downloads.push({item,bytes:await fetchBlob(item)});
      log('Скачан и проверен SHA: '+item.path);
    }

    const existing=downloads.filter(entry=>entry.item.exists);
    let backupPrefix='';
    if(existing.length){
      backupPrefix='.archiver-update-backup/browser-'+backupStamp();
      log('Резервная копия: '+backupPrefix);
      for(const entry of existing)await writeBytes(root,backupPrefix+'/'+entry.item.path,entry.item.local);
    }

    for(let i=0;i<downloads.length;i++){
      const entry=downloads[i];
      setStatus('Записываю '+(i+1)+' / '+downloads.length+': '+entry.item.path);
      await writeBytes(root,entry.item.path,entry.bytes);
      const written=await readBytes(root,entry.item.path);
      const writtenSha=written?await gitBlobSha(written):'';
      if(writtenSha!==entry.item.sha)throw new Error('После записи SHA не совпал: '+entry.item.path);
      log('Записан и проверен SHA: '+entry.item.path);
    }

    const finalManifest=await verifyInstallRoot(root);
    if(String(finalManifest.version)!==String(remote.version)){
      throw new Error('После записи manifest.json остался '+(finalManifest.version||'без версии')+', ожидалось '+remote.version+'.');
    }

    $('diskVersion').textContent=finalManifest.version;
    setStatus('Папка обновлена до '+finalManifest.version+'. Теперь нажмите «Перезагрузить расширение».','success');
    log('Готово: папка '+finalManifest.version+' · commit '+snapshot.commitSha.slice(0,12)+'.');
    if(backupPrefix)log('Резервная копия: '+backupPrefix);
    await persistLog();
  }catch(error){
    const message=error.message||String(error);
    setStatus(message,'error');
    log('ОШИБКА: '+message);
    await persistLog();
  }finally{
    setBusy(false);
  }
}

$('chooseFolder').onclick=async()=>{setBusy(true);try{await chooseFolder();setStatus('Папка выбрана. Можно обновлять.','success')}catch(error){setStatus(error.message||String(error),'error');log('ОШИБКА: '+(error.message||String(error)))}finally{setBusy(false)}};
$('forgetFolder').onclick=async()=>{await forgetHandle().catch(()=>{});rootHandle=null;await refreshFolderState();log('Сохранённый выбор папки удалён.')};
$('checkUpdate').onclick=checkUpdate;
$('runUpdate').onclick=runUpdate;
$('reloadExtension').onclick=()=>{setStatus('Перезагружаю расширение…');setTimeout(()=>chrome.runtime.reload(),120)};
$('copyLog').onclick=async()=>{await navigator.clipboard.writeText(logLines.join('\n'));setStatus('Лог скопирован.','success')};

(async()=>{$('loadedVersion').textContent=chrome.runtime.getManifest().version||'—';if(typeof window.showDirectoryPicker!=='function')$('fallback').classList.remove('hidden');try{rootHandle=await loadHandle()}catch(_){}await refreshFolderState();try{const snapshot=await fetchRepositorySnapshot();log('Страница обновления готова · commit '+snapshot.commitSha.slice(0,12));}catch(error){setStatus('Не удалось проверить GitHub: '+(error.message||String(error)),'error');log('ОШИБКА GitHub: '+(error.message||String(error)))}})();
