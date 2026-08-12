const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(freq, type = 'square', duration = 0.1) {
    if(audioCtx.state === 'suspended') return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    osc.connect(gain); gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
    osc.start(); osc.stop(audioCtx.currentTime + duration);
}

let deckgl = null;
document.addEventListener('DOMContentLoaded', () => {
    const startScreen = document.getElementById('start-screen');
    if (startScreen) {
        startScreen.addEventListener('click', () => {
            if(audioCtx.state === 'suspended') audioCtx.resume();
            playBeep(880, 'square', 0.15);
            setTimeout(() => playBeep(1200, 'square', 0.2), 150);
            startScreen.style.display = 'none';
            initMapAndDeck();
            connectWebSocket();
            loadFullHandbook();
        });
    }
});

function switchModule(modId) {
    playBeep(1200, 'sine', 0.1);
    document.querySelectorAll('.module-container').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('mod-' + modId).classList.add('active');
    event.currentTarget.classList.add('active');
    if(modId === 'vault') loadVault(); 
    if(modId === 'editorial') searchStylebook();
    if(modId === 'handbook') loadFullHandbook();
}

let userCoords = null;
if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition((position) => { userCoords = [position.coords.longitude, position.coords.latitude]; }, (err) => console.log(err), { enableHighAccuracy: true });
}

let currentViewState = { longitude: -118.2426, latitude: 34.0549, zoom: 9, pitch: 45, bearing: 0 };
let persistentEmergencies = [];
let latestAirTraffic = [];
let latestSurveillance = []; // Added ALPR state array
let activeRoutePath = null;
let t = 0;

function initMapAndDeck() {
    deckgl = new deck.DeckGL({
        container: 'map-container',
        mapboxGl: maplibregl,
        mapStyle: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        initialViewState: currentViewState, controller: true,
        onViewStateChange: ({viewState}) => { currentViewState = viewState; }, layers: []
    });
    requestAnimationFrame(renderLayers);
}

function connectWebSocket() {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const now = Date.now();
        if (data.emergencies && data.emergencies.length > 0) {
            data.emergencies.forEach(e => persistentEmergencies.push({...e, id: 'CAD-' + Math.floor(100000 + Math.random() * 900000), timestamp: now}));
            playBeep(1800, 'sawtooth', 0.1);
            const log = document.getElementById('log-console');
            if (log) log.innerHTML = `<div class="text-[#FF0033] truncate">[${new Date().toLocaleTimeString()}] PING: ${data.emergencies[0].type}</div>` + log.innerHTML;
        }
        latestAirTraffic = data.air_traffic || [];
        latestSurveillance = data.surveillance_nodes || []; // Capture ALPR nodes from payload
        const airStat = document.getElementById('stat-air');
        if (airStat) airStat.innerText = latestAirTraffic.length;
    };
}

async function calculateInAppRoute(startLon, startLat, endLon, endLat) {
    document.getElementById('navi-hud').classList.remove('hidden');
    document.getElementById('route-steps').innerHTML = '<div class="text-[#00E5FF] animate-pulse">> CALCULATING VECTOR PATHWAY...</div>';
    try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=true`);
        const data = await res.json();
        const route = data.routes[0];
        activeRoutePath = route.geometry.coordinates;
        document.getElementById('route-dist').innerText = `${(route.distance / 1609.34).toFixed(1)} MI`;
        document.getElementById('route-eta').innerText = `${Math.ceil(route.duration / 60)} MINS`;
        document.getElementById('route-steps').innerHTML = route.legs[0].steps.map((step, idx) => `
            <div class="border-b border-[#00E5FF]/20 pb-1">
                <span class="text-[#00FF66] font-bold">[STEP ${idx + 1}]</span> ${step.maneuver.type.toUpperCase()} ${step.name ? `ONTO ${step.name.toUpperCase()}` : ''}
                <div class="text-[10px] text-gray-400">TRANSIT: ${Math.round(step.distance)} METERS</div>
            </div>`).join('');
        playBeep(2200, 'sine', 0.2);
    } catch (err) { document.getElementById('route-steps').innerHTML = '<div class="text-[#FF0033]">❌ ROUTE FAILED.</div>'; }
}

function clearActiveRoute() { playBeep(800, 'square', 0.1); activeRoutePath = null; document.getElementById('navi-hud').classList.add('hidden'); }

let selectedTargetCoords = null;
// Updated function signature to handle ALPR Surveillance nodes
function showTargetCard(obj, isAir = false, isSurveillance = false) {
    playBeep(1400, 'sine', 0.08);
    const modal = document.getElementById('target-modal');
    modal.classList.remove('hidden');
    document.getElementById('target-id').innerText = obj.id || obj.callsign || 'ALPR-NODE';
    document.getElementById('target-coords').innerText = `${obj.coords[1].toFixed(4)}°, ${obj.coords[0].toFixed(4)}°`;
    selectedTargetCoords = obj.coords;

    if (isAir) {
        modal.classList.remove('border-[#FF0033]', 'border-[#ff00ff]');
        document.getElementById('target-title').innerText = "AIRCRAFT VECTOR"; document.getElementById('target-title').className = "font-bold text-[#00FF66]";
        document.getElementById('target-type').innerText = "CIVILIAN AIR"; document.getElementById('target-threat').innerText = "NOMINAL"; document.getElementById('target-threat').className = "text-[#00FF66] font-bold";
        document.getElementById('target-age').innerText = "LIVE STREAM";
    } else if (isSurveillance) {
        modal.classList.remove('border-[#FF0033]');
        modal.classList.add('border-[#ff00ff]'); // Add magenta border for ALPR
        document.getElementById('target-title').innerText = "SURVEILLANCE NODE"; document.getElementById('target-title').className = "font-bold text-[#ff00ff]";
        document.getElementById('target-type').innerText = obj.type || "ALPR"; document.getElementById('target-threat').innerText = obj.operator || "UNKNOWN"; document.getElementById('target-threat').className = "text-[#ff00ff] font-bold";
        document.getElementById('target-age').innerText = "STATIC";
    } else {
        if (obj.threat === 'RED') {
            modal.classList.add('border-[#FF0033]'); modal.classList.remove('border-[#ff00ff]');
        } else {
            modal.classList.remove('border-[#FF0033]', 'border-[#ff00ff]');
        }
        document.getElementById('target-title').innerText = "INCIDENT"; document.getElementById('target-title').className = "font-bold text-[#FF9900]";
        document.getElementById('target-type').innerText = obj.type; document.getElementById('target-threat').innerText = obj.threat === 'RED' ? 'PRIORITY 1' : 'PRIORITY 2';
        document.getElementById('target-threat').className = obj.threat === 'RED' ? 'text-[#FF0033] font-bold' : 'text-[#FF9900] font-bold';
        document.getElementById('target-age').innerText = `${Math.floor((Date.now() - obj.timestamp) / 1000)} SEC AGO`;
    }

    document.getElementById('lock-cam-btn').onclick = () => { deckgl.setProps({ initialViewState: { ...currentViewState, longitude: selectedTargetCoords[0], latitude: selectedTargetCoords[1], zoom: 14, transitionDuration: 1000 }}); };
    document.getElementById('directions-btn').onclick = () => { calculateInAppRoute(userCoords ? userCoords[0] : -118.2426, userCoords ? userCoords[1] : 34.0549, selectedTargetCoords[0], selectedTargetCoords[1]); };
}
function closeTargetCard() { document.getElementById('target-modal').classList.add('hidden'); }

function renderLayers() {
    t = (t + 1) % 100;
    const now = Date.now();
    persistentEmergencies = persistentEmergencies.filter(e => (now - e.timestamp) < 40000);
    const emgStat = document.getElementById('stat-emg');
    if (emgStat) emgStat.innerText = persistentEmergencies.length;

    if (!deckgl) { requestAnimationFrame(renderLayers); return; }

    const layers = [];
    if (userCoords) layers.push(new deck.ScatterplotLayer({ id: 'user', data: [{ coords: userCoords }], getPosition: d => d.coords, getFillColor: [0, 229, 255, 200], getRadius: (t * 2) + 10, radiusMinPixels: 6, radiusMaxPixels: 20, stroked: true, getLineColor: [255, 255, 255] }));
    if (activeRoutePath) layers.push(new deck.PathLayer({ id: 'route', data: [{ path: activeRoutePath }], getPath: d => d.path, getColor: [0, 229, 255, 220], getWidth: 8, widthMinPixels: 4 }));
    
    // Emergencies Layer
    layers.push(new deck.ScatterplotLayer({
        id: 'emergencies', data: persistentEmergencies.map(e => ({ ...e, alpha: (now - e.timestamp) > 30000 ? Math.max(0, Math.floor(220 * (1 - (((now - e.timestamp)/1000 - 30) / 10)))) : 220 })),
        getPosition: d => d.coords, getFillColor: d => d.threat === 'RED' ? [255, 0, 51, d.alpha] : [255, 153, 0, d.alpha],
        getRadius: d => (t * 8) + 20, radiusMinPixels: 8, radiusMaxPixels: 60, stroked: true, getLineColor: d => [255, 255, 255, d.alpha], pickable: true, onClick: (i) => { if (i.object) showTargetCard(i.object, false, false); }
    }));
    
    // Air Traffic Layer
    layers.push(new deck.ColumnLayer({
        id: 'air-traffic', data: latestAirTraffic, radius: 250, extruded: true, getPosition: d => [d.coords[0], d.coords[1]], getElevation: d => d.coords[2], getFillColor: [0, 255, 102, 160], pickable: true, onClick: (i) => { if (i.object) showTargetCard(i.object, true, false); }
    }));

    // New ALPR Surveillance Layer
    if (latestSurveillance.length > 0) {
        layers.push(new deck.ScatterplotLayer({
            id: 'surveillance',
            data: latestSurveillance,
            getPosition: d => d.coords,
            getFillColor: [255, 0, 255, 160], // High-visibility magenta
            getRadius: 15,
            radiusMinPixels: 4,
            radiusMaxPixels: 12,
            stroked: true,
            getLineColor: [255, 255, 255, 200],
            pickable: true,
            onClick: (i) => { if (i.object) showTargetCard(i.object, false, true); }
        }));
    }

    deckgl.setProps({ layers });
    requestAnimationFrame(renderLayers);
}

async function saveFieldNotes() {
    const content = document.getElementById('field-notes').value;
    if(!content) return;
    document.getElementById('save-status').innerText = "SAVING...";
    await fetch('/api/save-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    playBeep(2000, 'sine', 0.2);
    document.getElementById('save-status').innerText = "ENCRYPTION: LOCAL | SAVED";
}

async function loadVault() {
    const res = await fetch('/api/vault');
    const data = await res.json();
    document.getElementById('vault-directory').innerHTML = data.reverse().map(c => `
        <div class="border border-[#FF9900]/50 p-3 bg-black/60 mb-2">
            <div class="flex justify-between font-bold text-[#00E5FF] border-b border-[#00E5FF]/30 pb-1 mb-1">
                <span>${c.name}</span><span class="text-[10px] text-[#FF9900] uppercase bg-[#FF9900]/10 px-2 py-0.5">${c.status}</span>
            </div>
            <div class="text-xs text-white/80 font-mono">P: ${c.phone} | E: ${c.email}</div>
            <div class="text-xs text-[#00FF66] mt-2 font-mono">> ${c.notes}</div>
        </div>`).join('');
}

async function addToVault() {
    const payload = { name: document.getElementById('vault-name').value, status: document.getElementById('vault-status').value, phone: document.getElementById('vault-phone').value, email: document.getElementById('vault-email').value, notes: document.getElementById('vault-notes').value };
    if(!payload.name) return;
    await fetch('/api/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    playBeep(1600, 'sine', 0.15);
    loadVault();
}

async function scrubEXIF() {
    const file = document.getElementById('image-file').files[0];
    if(!file) return;
    const formData = new FormData(); formData.append("file", file);
    const res = await fetch('/api/scrub-exif', { method: 'POST', body: formData });
    if(res.ok) {
        const a = document.createElement('a'); a.href = window.URL.createObjectURL(await res.blob()); a.download = 'CLEANED_' + file.name;
        document.body.appendChild(a); a.click(); a.remove(); playBeep(1500, 'square', 0.3);
    }
}

async function runAPStyleCheck() {
    const text = document.getElementById('workbench-text').value;
    if(!text) return;
    playBeep(600, 'sawtooth', 0.2);
    document.getElementById('ap-results').innerHTML = '<div class="text-[#FF9900] animate-pulse">> Scanning copy...</div>';
    const res = await fetch('/api/check-style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const data = await res.json();
    playBeep(2400, 'sine', 0.2);
    if (data.flags.length === 0) { document.getElementById('ap-results').innerHTML = '<div class="text-[#00FF66] font-bold">> COPY IS CLEAN.</div>'; return; }
    document.getElementById('ap-results').innerHTML = data.flags.map(f => `
        <div class="border-l-2 border-[#FF9900] pl-2 mb-3 py-1 bg-black/40">
            <div class="text-[10px] text-[#00E5FF] font-bold">${f.type}</div>
            <div class="text-[#FF0033] font-bold">MATCH: "${f.error}"</div>
            <div class="text-[#00FF66] text-[11px] mt-1">> ${f.suggestion}</div>
        </div>`).join('');
}

async function searchStylebook() {
    const q = document.getElementById('stylebook-search').value;
    const res = await fetch(`/api/stylebook/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const container = document.getElementById('stylebook-results');
    if (!data.results || data.results.length === 0) { container.innerHTML = '<div class="text-gray-500">> No match found.</div>'; return; }
    container.innerHTML = data.results.map(r => `
        <div class="border-b border-[#00E5FF]/30 pb-2 mb-2 bg-black/40 p-2">
            <div class="text-[#00E5FF] font-bold uppercase tracking-wider">${r.term}</div>
            <div class="text-gray-300 text-[11px] mt-1">${r.rule}</div>
        </div>`).join('');
}

// --- MULTI-VOLUME CODEX LOGIC ---
let fullCodexDatabase = [];
let activeFolder = null;
let currentVolume = 'ALL';

async function loadFullHandbook() {
    if (fullCodexDatabase.length === 0) {
        document.getElementById('codex-folders').innerHTML = '<div class="text-xs text-[#00FF66] animate-pulse p-2">> FETCHING LIBRARY...</div>';
        try {
            const res = await fetch('/api/stylebook/all');
            const data = await res.json();
            fullCodexDatabase = data.database;
            buildCodexFolders();
            selectFolder('📚 GUIDES & CHAPTERS');
            playBeep(2000, 'sine', 0.2);
        } catch (e) {
            document.getElementById('codex-folders').innerHTML = '<div class="text-xs text-[#FF0033] p-2">❌ LIBRARY ERROR</div>';
        }
    }
}

function setLibraryVolume(vol) {
    playBeep(1200, 'sine', 0.1);
    currentVolume = vol;
    
    // Update tab button styles
    ['ALL', 'AP', 'STRUNK'].forEach(v => {
        const btn = document.getElementById(`lib-btn-${v}`);
        if(btn) {
            btn.className = "lib-tab px-3 py-1 border border-[#00FF66]/40 text-[#00FF66] hover:bg-[#00FF66]/10 transition-all";
        }
    });
    const activeBtn = document.getElementById(`lib-btn-${vol === 'ALL' ? 'ALL' : (vol === 'AP STYLE' ? 'AP' : 'STRUNK')}`);
    if(activeBtn) {
        activeBtn.className = "lib-tab active px-3 py-1 border border-[#00FF66] text-[#00FF66] bg-[#00FF66]/20 font-bold transition-all";
    }

    buildCodexFolders();
    selectFolder('📚 GUIDES & CHAPTERS');
}

function buildCodexFolders(filterQuery = '') {
    const foldersContainer = document.getElementById('codex-folders');
    const query = filterQuery.toUpperCase();

    // Filter database by active volume
    let filteredDb = fullCodexDatabase;
    if (currentVolume !== 'ALL') {
        filteredDb = fullCodexDatabase.filter(item => item.library === currentVolume);
    }

    const chapterItems = filteredDb.filter(item => item.term.includes('CHAPTER:') || item.term.includes('★'));
    const standardItems = filteredDb.filter(item => !item.term.includes('CHAPTER:') && !item.term.includes('★'));

    let alphabetGroups = {};
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(letter => {
        // Strip volume tags like "[AP STYLE] " when checking first letter
        alphabetGroups[letter] = standardItems.filter(item => {
            let cleanTerm = item.term.replace(/^\[.*?\]\s*/, '').toUpperCase();
            return cleanTerm.startsWith(letter);
        });
    });

    let html = '';
    if (chapterItems.length > 0) {
        html += `
            <div onclick="selectFolder('📚 GUIDES & CHAPTERS')" class="cursor-pointer px-3 py-2 text-xs font-mono uppercase transition-all flex justify-between items-center ${activeFolder === '📚 GUIDES & CHAPTERS' ? 'bg-[#00FF66] text-black font-bold' : 'text-[#00FF66] hover:bg-[#00FF66]/20'}">
                <span>📚 GUIDES & CHAPTERS</span>
                <span class="text-[10px] opacity-70">(${chapterItems.length})</span>
            </div>
        `;
    }

    Object.keys(alphabetGroups).forEach(letter => {
        const count = alphabetGroups[letter].length;
        if (count > 0 && (!query || letter.includes(query))) {
            html += `
                <div onclick="selectFolder('${letter}')" class="cursor-pointer px-3 py-2 text-xs font-mono uppercase transition-all flex justify-between items-center ${activeFolder === letter ? 'bg-[#00FF66] text-black font-bold' : 'text-[#00FF66] hover:bg-[#00FF66]/20'}">
                    <span>[FOLDER] ${letter}</span>
                    <span class="text-[10px] opacity-70">(${count})</span>
                </div>
            `;
        }
    });

    foldersContainer.innerHTML = html || '<div class="text-xs text-[#FF9900] p-2">NO FOLDERS FOUND</div>';
}

function selectFolder(folderKey) {
    playBeep(1400, 'square', 0.05);
    activeFolder = folderKey;
    buildCodexFolders(document.getElementById('codex-search').value);

    let filteredDb = fullCodexDatabase;
    if (currentVolume !== 'ALL') {
        filteredDb = fullCodexDatabase.filter(item => item.library === currentVolume);
    }

    const indexList = document.getElementById('codex-index-list');
    const indexTitle = document.getElementById('index-title');
    const indexCount = document.getElementById('index-count');

    let entries = [];
    if (folderKey === '📚 GUIDES & CHAPTERS') {
        entries = filteredDb.filter(item => item.term.includes('CHAPTER:') || item.term.includes('★'));
    } else {
        entries = filteredDb.filter(item => {
            let cleanTerm = item.term.replace(/^\[.*?\]\s*/, '').toUpperCase();
            return cleanTerm.startsWith(folderKey) && !item.term.includes('CHAPTER:') && !item.term.includes('★');
        });
    }

    indexTitle.innerText = `FOLDER: [ ${folderKey} ]`;
    indexCount.innerText = `${entries.length} ENTRIES`;

    indexList.innerHTML = entries.map((entry) => `
        <div onclick='loadIntoReadingPane(${JSON.stringify(entry.term)})' class="cursor-pointer px-2 py-1.5 text-xs font-mono text-[#00FF66] hover:bg-[#00FF66] hover:text-black transition-colors truncate border-b border-[#00FF66]/10">
            > ${entry.term}
        </div>
    `).join('') || '<div class="text-xs text-[#FF9900] p-2">EMPTY</div>';
}

function formatCodexRuleText(ruleText) {
    if (!ruleText) return '';
    let safeText = ruleText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    safeText = safeText.replace(/(See\s+also\s+|See\s+)([a-zA-Z0-9\-\s]+)(\.)/gi, (match, prefix, term, ending) => {
        let cleanTerm = term.trim();
        return `${prefix}<span onclick="jumpToCodexTerm('${cleanTerm}')" class="text-[#00E5FF] underline cursor-pointer hover:bg-[#00E5FF]/20 font-bold">${cleanTerm}</span>${ending}`;
    });
    return safeText;
}

function loadIntoReadingPane(termKey) {
    playBeep(1800, 'sine', 0.08);
    const entry = fullCodexDatabase.find(i => i.term === termKey);
    if (!entry) return;

    document.getElementById('reading-term').innerText = entry.term;
    document.getElementById('reading-rule').innerHTML = formatCodexRuleText(entry.rule);
    document.getElementById('reading-status').innerText = "BUFFER: LOADED";
}

window.jumpToCodexTerm = function(targetTerm) {
    playBeep(2200, 'sine', 0.1);
    const found = fullCodexDatabase.find(i => i.term.toLowerCase().includes(targetTerm.toLowerCase()));
    if (found) {
        let firstLetter = found.term.replace(/^\[.*?\]\s*/, '').charAt(0).toUpperCase();
        if (found.term.includes('CHAPTER:') || found.term.includes('★')) {
            selectFolder('📚 GUIDES & CHAPTERS');
        } else if ('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(firstLetter)) {
            selectFolder(firstLetter);
        }
        loadIntoReadingPane(found.term);
    } else {
        playBeep(400, 'sawtooth', 0.2);
    }
}

function filterCodexIndex() {
    buildCodexFolders(document.getElementById('codex-search').value);
}