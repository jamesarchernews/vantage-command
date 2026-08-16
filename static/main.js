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

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    if(modId === 'vault') renderVaultDirectory(); 
    if(modId === 'editorial') searchStylebook();
    if(modId === 'handbook') loadFullHandbook();
}

// --- TELEMETRY TOGGLE ---
let telemetryExpanded = true;
function toggleTelemetry() {
    telemetryExpanded = !telemetryExpanded;
    const box = document.getElementById('telemetry-box');
    const content = document.getElementById('telemetry-content');
    const collapsed = document.getElementById('telemetry-collapsed');
    const btn = document.getElementById('tel-toggle-btn');
    
    if (telemetryExpanded) {
        content.classList.remove('hidden');
        collapsed.classList.add('hidden');
        btn.innerText = '[ - ]';
        box.classList.remove('w-auto', 'py-1', 'px-3');
        box.classList.add('w-72', 'p-0');
    } else {
        content.classList.add('hidden');
        collapsed.classList.remove('hidden');
        btn.innerText = '[ + ]';
        box.classList.remove('w-72', 'p-0');
        box.classList.add('w-auto', 'py-1', 'px-3');
    }
}

function syncMiniTicker() {
    if(!telemetryExpanded) {
        document.getElementById('stat-air-mini').innerText = latestAirTraffic.length;
        document.getElementById('stat-emg-mini').innerText = persistentEmergencies.length;
    }
}
setInterval(syncMiniTicker, 2000);

let userCoords = null;
if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition((position) => { userCoords = [position.coords.longitude, position.coords.latitude]; }, (err) => console.log(err), { enableHighAccuracy: true });
}

let currentViewState = { longitude: -118.2426, latitude: 34.0549, zoom: 9, pitch: 45, bearing: 0 };
let persistentEmergencies = [];

// Layer States
let latestALPR = [];
let latestSurv = [];
let latestDC = [];
let latestGNSS = [];
let latestAirTraffic = [];

let showALPR = true;
let showSurv = true;
let showDC = true;
let showGNSS = true;
let showAir = true;

let activeRoutePath = null;
let searchPinCoords = null;
let transitData = [];
let showTransit = false;
let t = 0;

window.updateLayers = function() {
    showALPR = document.getElementById('layer-alpr').checked;
    showSurv = document.getElementById('layer-surv').checked;
    showDC = document.getElementById('layer-dc').checked;
    showGNSS = document.getElementById('layer-gnss').checked;
    showAir = document.getElementById('layer-air').checked;
    requestAnimationFrame(renderLayers);
};

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
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const now = Date.now();
        if (data.emergencies && data.emergencies.length > 0) {
            data.emergencies.forEach(e => persistentEmergencies.push({...e, id: 'CAD-' + Math.floor(100000 + Math.random() * 900000), timestamp: now}));
            playBeep(1800, 'sawtooth', 0.1);
            const log = document.getElementById('log-console');
            if (log) log.innerHTML = `<div class="text-[#FF0033] truncate">[${new Date().toLocaleTimeString()}] PING: ${data.emergencies[0].type}</div>` + log.innerHTML;
        }
        
        latestALPR = data.alpr_nodes || [];
        latestSurv = data.surv_nodes || [];
        latestDC = data.dc_nodes || [];
        latestGNSS = data.gnss_nodes || [];
        latestAirTraffic = (data.air_traffic || []).map(a => ({...a, type: 'CIVILIAN AIR', operator: 'ATC VECTOR'}));
        
        const airStat = document.getElementById('stat-air');
        if (airStat) airStat.innerText = latestAirTraffic.length;
    };
    ws.onclose = () => { setTimeout(connectWebSocket, 3000); };
}

// --- SEARCH & TRANSIT LAYERS ---
async function handleMapSearch(e) {
    if (e.key === 'Enter') {
        const q = e.target.value.trim();
        if (!q) return;
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&viewbox=-118.8,34.5,-117.5,33.5&bounded=1&format=json`);
            const data = await res.json();
            if(data && data.length > 0) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);
                searchPinCoords = [lon, lat];
                deckgl.setProps({ initialViewState: { ...currentViewState, longitude: lon, latitude: lat, zoom: 15, transitionDuration: 1500 }});
                playBeep(1800, 'sine', 0.1);
            } else {
                playBeep(400, 'sawtooth', 0.2);
            }
        } catch(err) { console.error(err); }
    }
}

async function toggleTransitLayer() {
    showTransit = !showTransit;
    const btn = document.getElementById('btn-transit');
    btn.classList.toggle('bg-[#FF9900]');
    btn.classList.toggle('text-black');
    
    if (showTransit && transitData.length === 0) {
        playBeep(1200, 'sawtooth', 0.1);
        btn.innerText = "[ 🚆 LOADING TRANSIT... ]";
        try {
            const query = `[out:json][timeout:25];(way["route"~"subway|light_rail|bus"](33.5,-118.8,34.5,-117.5););out geom;`;
            const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(query) });
            const data = await res.json();
            transitData = data.elements.map(e => ({ path: e.geometry.map(g => [g.lon, g.lat]) }));
            btn.innerText = "[ 🚆 TRANSIT LAYER ACTIVE ]";
            playBeep(2400, 'sine', 0.1);
        } catch(err) {
            btn.innerText = "[ 🚆 TRANSIT LAYER FAILED ]";
        }
    } else {
        btn.innerText = showTransit ? "[ 🚆 TRANSIT LAYER ACTIVE ]" : "[ 🚆 TRANSIT LAYER ]";
    }
}

// --- GPS ROUTING REPAIR ---
async function calculateInAppRoute(endLon, endLat) {
    const routeBox = document.getElementById('route-output-area');
    routeBox.classList.remove('hidden');
    document.getElementById('route-steps').innerHTML = '<div class="text-[#00E5FF] animate-pulse">> CALCULATING VECTOR PATHWAY...</div>';
    
    let sLon = userCoords ? userCoords[0] : -118.2426;
    let sLat = userCoords ? userCoords[1] : 34.0549;

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${sLon},${sLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=true`;
        const res = await fetch(url);
        const data = await res.json();
        
        if(data.code !== 'Ok') throw new Error("OSRM Failed");

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
    } catch (err) { 
        document.getElementById('route-steps').innerHTML = '<div class="text-[#FF0033]">❌ ROUTE FAILED. VERIFY GPS.</div>'; 
    }
}

function clearActiveRoute() { 
    playBeep(800, 'square', 0.1); 
    activeRoutePath = null; 
    document.getElementById('route-output-area').classList.add('hidden'); 
}

let selectedTargetCoords = null;
function showTargetCard(obj) {
    playBeep(1400, 'sine', 0.08);
    const modal = document.getElementById('target-modal');
    modal.classList.remove('hidden');
    document.getElementById('target-id').innerText = obj.name || obj.callsign || obj.id || 'NODE DEPLOYMENT';
    document.getElementById('target-coords').innerText = obj.coords ? `${obj.coords[1].toFixed(4)}°, ${obj.coords[0].toFixed(4)}°` : '--';
    selectedTargetCoords = obj.coords;

    document.getElementById('target-title').innerText = "TARGET ACQUIRED"; 
    
    let themeColor = 'text-[#FF9900]';
    let borderColor = 'border-[#FF9900]';
    
    if(obj.type && obj.type.includes('ALPR')) { themeColor = 'text-[#ff00ff]'; borderColor = 'border-[#ff00ff]'; }
    else if(obj.type && obj.type.includes('SURV') || obj.type && obj.type.includes('CCTV')) { themeColor = 'text-[#FF6600]'; borderColor = 'border-[#FF6600]'; }
    else if(obj.type && obj.type.includes('DATA')) { themeColor = 'text-[#FFB400]'; borderColor = 'border-[#FFB400]'; }
    else if(obj.type && obj.type.includes('GNSS') || obj.type && obj.type.includes('TOWER')) { themeColor = 'text-[#00E5FF]'; borderColor = 'border-[#00E5FF]'; }
    else if(obj.type && obj.type.includes('AIR')) { themeColor = 'text-[#00FF66]'; borderColor = 'border-[#00FF66]'; }
    else if(obj.threat === 'RED') { themeColor = 'text-[#FF0033]'; borderColor = 'border-[#FF0033]'; }

    document.getElementById('target-title').className = `font-bold ${themeColor}`;
    modal.className = `absolute left-4 top-40 z-[600] w-80 max-h-[70vh] overflow-y-auto p-4 hud-panel pointer-events-auto border-2 ${borderColor} bg-[#05080A]/95 backdrop-blur-md relative`;

    document.getElementById('target-type').innerText = obj.type || "SENSOR"; 
    document.getElementById('target-threat').innerText = obj.operator || obj.threat || "UNKNOWN"; 
    document.getElementById('target-threat').className = `${themeColor} font-bold`;

    document.getElementById('lock-cam-btn').onclick = () => { deckgl.setProps({ initialViewState: { ...currentViewState, longitude: selectedTargetCoords[0], latitude: selectedTargetCoords[1], zoom: 16, transitionDuration: 1000 }}); };
    document.getElementById('directions-btn').onclick = () => { calculateInAppRoute(selectedTargetCoords[0], selectedTargetCoords[1]); };
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
    
    if (searchPinCoords) {
        layers.push(new deck.ScatterplotLayer({ id: 'search-pin', data: [{coords: searchPinCoords}], getPosition: d=>d.coords, getFillColor: [0, 229, 255, 200], getRadius: 50, radiusMinPixels: 8, radiusMaxPixels: 25, stroked: true, getLineColor: [255, 255, 255, 255] }));
    }

    if (showTransit && transitData.length > 0) {
        layers.push(new deck.PathLayer({ id: 'transit-lines', data: transitData, getPath: d=>d.path, getColor: [0, 229, 255, 120], getWidth: 15, widthMinPixels: 2 }));
    }

    if (showALPR && latestALPR.length > 0) {
        layers.push(new deck.ScatterplotLayer({
            id: 'alpr', data: latestALPR, getPosition: d => d.coords, getFillColor: [255, 0, 255, 200], getRadius: 50, radiusMinPixels: 4, radiusMaxPixels: 15, stroked: true, getLineColor: [255, 255, 255, 200], pickable: true, onClick: (i) => { if(i.object) showTargetCard(i.object); }
        }));
    }

    if (showSurv && latestSurv.length > 0) {
        layers.push(new deck.ScatterplotLayer({
            id: 'surv', data: latestSurv, getPosition: d => d.coords, getFillColor: [255, 102, 0, 200], getRadius: 50, radiusMinPixels: 4, radiusMaxPixels: 15, stroked: true, getLineColor: [255, 255, 255, 200], pickable: true, onClick: (i) => { if(i.object) showTargetCard(i.object); }
        }));
    }

    if (showDC && latestDC.length > 0) {
        layers.push(new deck.ColumnLayer({
            id: 'dc', data: latestDC, getPosition: d => d.coords, getElevation: 100, getFillColor: [255, 180, 0, 180], radius: 150, extruded: true, pickable: true, onClick: (i) => { if(i.object) showTargetCard(i.object); }
        }));
    }

    if (showGNSS && latestGNSS.length > 0) {
        layers.push(new deck.ScatterplotLayer({
            id: 'gnss', data: latestGNSS, getPosition: d => d.coords, getFillColor: [0, 229, 255, 200], getRadius: 40, radiusMinPixels: 3, radiusMaxPixels: 10, stroked: true, getLineColor: [255, 255, 255, 200], pickable: true, onClick: (i) => { if(i.object) showTargetCard(i.object); }
        }));
    }

    if (showAir && latestAirTraffic.length > 0) {
        layers.push(new deck.ColumnLayer({
            id: 'air-traffic', data: latestAirTraffic, radius: 250, extruded: true, getPosition: d => [d.coords[0], d.coords[1]], getElevation: d => d.coords[2], getFillColor: [0, 255, 102, 160], pickable: true, onClick: (i) => { if(i.object) showTargetCard(i.object); }
        }));
    }
    
    layers.push(new deck.ScatterplotLayer({
        id: 'emergencies', data: persistentEmergencies.map(e => ({ ...e, alpha: (now - e.timestamp) > 30000 ? Math.max(0, Math.floor(220 * (1 - (((now - e.timestamp)/1000 - 30) / 10)))) : 220, operator: e.threat, name: "INCIDENT" })),
        getPosition: d => d.coords, getFillColor: d => d.threat === 'RED' ? [255, 0, 51, d.alpha] : [255, 153, 0, d.alpha],
        getRadius: d => (t * 8) + 20, radiusMinPixels: 8, radiusMaxPixels: 60, stroked: true, getLineColor: d => [255, 255, 255, d.alpha], pickable: true, onClick: (i) => { if (i.object) showTargetCard(i.object); }
    }));

    deckgl.setProps({ layers });
    requestAnimationFrame(renderLayers);
}

// --- WEBCRYPTO AES-GCM ZERO-TRUST ENCRYPTION UTILS ---
async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), {name: "PBKDF2"}, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        {name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256"},
        keyMaterial, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]
    );
}

async function encryptData(text, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const enc = new TextEncoder();
    const encrypted = await crypto.subtle.encrypt({name: "AES-GCM", iv: iv}, key, enc.encode(text));
    return JSON.stringify({ salt: Array.from(salt), iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) });
}

async function decryptData(encryptedString, password) {
    try {
        const obj = JSON.parse(encryptedString);
        const salt = new Uint8Array(obj.salt);
        const iv = new Uint8Array(obj.iv);
        const data = new Uint8Array(obj.data);
        const key = await deriveKey(password, salt);
        const decrypted = await crypto.subtle.decrypt({name: "AES-GCM", iv: iv}, key, data);
        return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
}

function downloadSecureFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
}

// --- NOTEBOOK COMMANDS & BUTTONS ---
async function saveEncryptedNoteBtn() {
    const notesArea = document.getElementById('field-notes');
    if(!notesArea.value) return;
    const pass = prompt("Enter encryption passphrase for this file:");
    if (pass) {
        const enc = await encryptData(notesArea.value, pass);
        downloadSecureFile(`Encrypted_Log_${Date.now()}.enc`, enc);
        document.getElementById('save-status').innerText = "ENCRYPTION: AES-GCM | EXPORTED";
    }
}

function exportTextNoteBtn() {
    const notesArea = document.getElementById('field-notes');
    if(!notesArea.value) return;
    downloadSecureFile(`Field_Log_${Date.now()}.txt`, notesArea.value);
}

async function handleNotebookCommand(e) {
    if (e.key === 'Enter') {
        const input = document.getElementById('note-cmd');
        const notesArea = document.getElementById('field-notes');
        const cmd = input.value.trim().toLowerCase();
        if (cmd === ':ts' || cmd === ':timestamp') { notesArea.value += `\n[${new Date().toISOString()}] - `; } 
        else if (cmd === ':clear') { notesArea.value = ''; } 
        else if (cmd === ':export') { exportTextNoteBtn(); } 
        else if (cmd === ':encrypt') { await saveEncryptedNoteBtn(); }
        input.value = '';
    }
}

// --- IN-MEMORY CONTACTS CRM ---
let localVaultMemory = [];

function addToVault() {
    const payload = { 
        name: document.getElementById('vault-name').value, 
        status: document.getElementById('vault-status').value, 
        phone: document.getElementById('vault-phone').value, 
        email: document.getElementById('vault-email').value, 
        notes: document.getElementById('vault-notes').value 
    };
    if(!payload.name) return;
    localVaultMemory.push(payload);
    playBeep(1600, 'sine', 0.15);
    renderVaultDirectory();
    document.getElementById('vault-name').value = '';
    document.getElementById('vault-notes').value = '';
}

function renderVaultDirectory() {
    document.getElementById('vault-directory').innerHTML = localVaultMemory.map((c, i) => `
        <div class="border border-[#FF9900]/50 p-3 bg-black/60 mb-2">
            <div class="flex justify-between font-bold text-[#00E5FF] border-b border-[#00E5FF]/30 pb-1 mb-1">
                <span>${c.name}</span><span class="text-[10px] text-[#FF9900] uppercase bg-[#FF9900]/10 px-2 py-0.5">${c.status}</span>
            </div>
            <div class="text-xs text-white/80 font-mono">P: ${c.phone} | E: ${c.email}</div>
            <div class="text-xs text-[#00FF66] mt-2 font-mono">> ${c.notes}</div>
        </div>`).join('');
}

async function exportVault() {
    if(localVaultMemory.length === 0) return alert("Memory is empty.");
    const pass = prompt("Enter passphrase to encrypt Source Vault:");
    if(!pass) return;
    const enc = await encryptData(JSON.stringify(localVaultMemory), pass);
    downloadSecureFile(`Source_Vault_${Date.now()}.enc`, enc);
}

function loadVaultFile(e) {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
        const pass = prompt("Enter decryption passphrase:");
        if(!pass) return;
        const decrypted = await decryptData(event.target.result, pass);
        if(decrypted) {
            localVaultMemory = JSON.parse(decrypted);
            renderVaultDirectory();
            playBeep(2000, 'sine', 0.2);
        } else {
            alert("Decryption failed. Incorrect passphrase.");
        }
    };
    reader.readAsText(file);
}

// --- EXIF SCRUBBER ---
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

// --- AP EDITOR STABLE REAL-TIME SCANNER ---
let apCheckTimeout = null;

function debouncedAPCheck() {
    clearTimeout(apCheckTimeout);
    const text = document.getElementById('workbench-text').value;
    document.getElementById('workbench-preview').innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    apCheckTimeout = setTimeout(runAPStyleCheck, 300);
}

async function runAPStyleCheck() {
    const text = document.getElementById('workbench-text').value;
    const previewBox = document.getElementById('workbench-preview');
    const resultsBox = document.getElementById('ap-results');
    
    if (!text || !text.trim()) { 
        if (previewBox) previewBox.innerHTML = '<em>> Live Analysis Buffer idle...</em>'; 
        if (resultsBox) resultsBox.innerHTML = '<div class="text-[#00FF66] font-bold">> READY FOR COPY.</div>';
        return; 
    }
    
    try {
        const res = await fetch('/api/check-style', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ text }) 
        });
        if (!res.ok) throw new Error("API returned non-200");
        const data = await res.json();
        
        if (!data.flags || data.flags.length === 0) { 
            if (resultsBox) resultsBox.innerHTML = '<div class="text-[#00FF66] font-bold">> COPY IS CLEAN. NO ISSUES DETECTED.</div>'; 
            if (previewBox) previewBox.innerHTML = escapeHtml(text).replace(/\n/g, '<br>'); 
            return; 
        }
        
        playBeep(2400, 'sine', 0.15);
        
        let safeText = escapeHtml(data.original_text);
        const sortedFlags = data.flags.sort((a,b) => b.error.length - a.error.length);
        
        sortedFlags.forEach(f => {
            if (!f.error) return;
            const escapedErr = escapeRegExp(escapeHtml(f.error));
            const spanClass = f.level === 'red' 
                ? 'bg-[#FF0033]/30 border border-[#FF0033] text-[#FF0033] px-1 font-bold shadow-[0_0_8px_rgba(255,0,51,0.6)]' 
                : 'bg-[#FF9900]/30 border border-[#FF9900] text-[#FF9900] px-1 font-bold shadow-[0_0_8px_rgba(255,153,0,0.6)]';
            
            const regex = new RegExp(`\\b(${escapedErr})\\b(?![^<]*>)`, 'gi');
            safeText = safeText.replace(regex, `<span class="${spanClass}">$1</span>`);
        });
        
        if (previewBox) previewBox.innerHTML = safeText.replace(/\n/g, '<br>');
        
        if (resultsBox) {
            resultsBox.innerHTML = data.flags.map(f => {
                const color = f.level === 'red' ? 'text-[#FF0033]' : 'text-[#FF9900]';
                const border = f.level === 'red' ? 'border-[#FF0033]' : 'border-[#FF9900]';
                return `
                <div class="border-l-2 ${border} pl-2 mb-2 py-1 bg-black/60">
                    <div class="text-[10px] text-[#00E5FF] font-bold uppercase">${f.type}</div>
                    <div class="${color} font-bold text-xs">FLAGGED: "${escapeHtml(f.error)}"</div>
                    <div class="text-[#00FF66] text-[11px] mt-0.5">> ${escapeHtml(f.suggestion)}</div>
                </div>`;
            }).join('');
        }
    } catch (err) {
        console.error("Style check error:", err);
        if (resultsBox) resultsBox.innerHTML = '<div class="text-[#FF0033] font-bold">❌ SCANNER ENGINE ERROR. VERIFY SERVER STATUS.</div>';
    }
}

function toggleAccordion(id) {
    const content = document.getElementById(id);
    if(content.classList.contains('hidden')) { content.classList.remove('hidden'); } else { content.classList.add('hidden'); }
}

async function searchStylebook() {
    const q = document.getElementById('stylebook-search').value;
    const res = await fetch(`/api/stylebook/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const container = document.getElementById('stylebook-results');
    if (!data.results || data.results.length === 0) { container.innerHTML = '<div class="text-[#00E5FF]/50">> NO MATCH FOUND.</div>'; return; }
    
    container.innerHTML = data.results.map((r, idx) => {
        const displayName = r.term.replace('[AP STYLE] CHAPTER:', '[AP]').replace('[AP STYLE]', '[AP]');
        return `
        <div class="border border-[#00E5FF]/30 bg-black mb-1">
            <div onclick="toggleAccordion('acc-${idx}')" class="cursor-pointer p-2 bg-[#00E5FF]/10 text-[#00E5FF] font-bold uppercase tracking-wider flex justify-between items-center hover:bg-[#00E5FF]/20 transition-all truncate">
                <span class="truncate pr-2">${displayName}</span> <span>▼</span>
            </div>
            <div id="acc-${idx}" class="hidden p-2 text-gray-300 text-[11px] border-t border-[#00E5FF]/30">${r.rule}</div>
        </div>`
    }).join('');
}

async function saveEncryptedDraft() {
    const draft = document.getElementById('workbench-text').value;
    if(!draft) return;
    const pass = prompt("Enter passphrase to secure Editor Draft:");
    if(pass) {
        const enc = await encryptData(draft, pass);
        downloadSecureFile(`AP_Draft_${Date.now()}.enc`, enc);
    }
}

// --- GLOBAL CODEX SEARCH & DIRECTORY ---
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
    ['ALL', 'AP', 'STRUNK'].forEach(v => {
        const btn = document.getElementById(`lib-btn-${v}`);
        if(btn) { btn.className = "lib-tab px-3 py-1 border border-[#00FF66]/40 text-[#00FF66] hover:bg-[#00FF66]/10 transition-all"; }
    });
    const activeBtn = document.getElementById(`lib-btn-${vol === 'ALL' ? 'ALL' : (vol === 'AP STYLE' ? 'AP' : 'STRUNK')}`);
    if(activeBtn) { activeBtn.className = "lib-tab active px-3 py-1 border border-[#00FF66] text-[#00FF66] bg-[#00FF66]/20 font-bold transition-all"; }
    buildCodexFolders();
    selectFolder('📚 GUIDES & CHAPTERS');
}

function filterGlobalCodex() {
    const query = document.getElementById('global-codex-search').value.toUpperCase();
    buildCodexFolders(query); 
    
    if (query.length > 1) {
        const indexList = document.getElementById('codex-index-list');
        const indexTitle = document.getElementById('index-title');
        const indexCount = document.getElementById('index-count');

        const results = fullCodexDatabase.filter(item => item.term.toUpperCase().includes(query) || item.rule.toUpperCase().includes(query));

        indexTitle.innerText = `[ GLOBAL SEARCH ]`;
        indexCount.innerText = `${results.length} HITS`;

        indexList.innerHTML = results.map((entry) => {
            const displayTerm = entry.term.replace('[AP STYLE] CHAPTER:', '[AP]').replace('[AP STYLE]', '[AP]');
            return `
            <div onclick='loadIntoReadingPane(${JSON.stringify(entry.term)})' class="cursor-pointer px-2 py-1.5 text-xs font-mono text-[#00FF66] hover:bg-[#00FF66] hover:text-black transition-colors truncate border-b border-[#00FF66]/10">
                > ${displayTerm}
            </div>`
        }).join('') || '<div class="text-xs text-[#FF9900] p-2">NO MATCHES</div>';
    }
}

function buildCodexFolders(filterQuery = '') {
    const foldersContainer = document.getElementById('codex-folders');
    const query = filterQuery.toUpperCase();
    let filteredDb = currentVolume !== 'ALL' ? fullCodexDatabase.filter(item => item.library === currentVolume) : fullCodexDatabase;
    const chapterItems = filteredDb.filter(item => item.term.includes('CHAPTER:') || item.term.includes('★'));
    const standardItems = filteredDb.filter(item => !item.term.includes('CHAPTER:') && !item.term.includes('★'));

    let alphabetGroups = {};
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(letter => {
        alphabetGroups[letter] = standardItems.filter(item => {
            let cleanTerm = item.term.replace(/^\[.*?\]\s*/, '').toUpperCase();
            return cleanTerm.startsWith(letter);
        });
    });

    let html = '';
    if (chapterItems.length > 0) {
        html += `<div onclick="selectFolder('📚 GUIDES & CHAPTERS')" class="cursor-pointer px-3 py-2 text-xs font-mono uppercase transition-all flex justify-between items-center ${activeFolder === '📚 GUIDES & CHAPTERS' ? 'bg-[#00FF66] text-black font-bold' : 'text-[#00FF66] hover:bg-[#00FF66]/20'}"><span>📚 GUIDES & CHAPTERS</span><span class="text-[10px] opacity-70">(${chapterItems.length})</span></div>`;
    }

    Object.keys(alphabetGroups).forEach(letter => {
        const count = alphabetGroups[letter].length;
        if (count > 0 && (!query || letter.includes(query))) {
            html += `<div onclick="selectFolder('${letter}')" class="cursor-pointer px-3 py-2 text-xs font-mono uppercase transition-all flex justify-between items-center ${activeFolder === letter ? 'bg-[#00FF66] text-black font-bold' : 'text-[#00FF66] hover:bg-[#00FF66]/20'}"><span>${letter}</span><span class="text-[10px] opacity-70">(${count})</span></div>`;
        }
    });
    foldersContainer.innerHTML = html || '<div class="text-xs text-[#FF9900] p-2">EMPTY DIRECTORY</div>';
}

function selectFolder(folderKey) {
    playBeep(1400, 'square', 0.05);
    activeFolder = folderKey;
    buildCodexFolders(document.getElementById('global-codex-search').value);

    let filteredDb = currentVolume !== 'ALL' ? fullCodexDatabase.filter(item => item.library === currentVolume) : fullCodexDatabase;
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

    indexList.innerHTML = entries.map((entry) => {
        const displayTerm = entry.term.replace('[AP STYLE] CHAPTER:', '[AP]').replace('[AP STYLE]', '[AP]');
        return `
        <div onclick='loadIntoReadingPane(${JSON.stringify(entry.term)})' class="cursor-pointer px-2 py-1.5 text-xs font-mono text-[#00FF66] hover:bg-[#00FF66] hover:text-black transition-colors truncate border-b border-[#00FF66]/10">
            > ${displayTerm}
        </div>`
    }).join('') || '<div class="text-xs text-[#FF9900] p-2">EMPTY</div>';
}

function formatCodexRuleText(ruleText) {
    if (!ruleText) return '';
    let safeText = escapeHtml(ruleText);
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
    const displayTerm = entry.term.replace('[AP STYLE] CHAPTER:', '[AP]').replace('[AP STYLE]', '[AP]');
    document.getElementById('reading-term').innerText = displayTerm;
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
    } else { playBeep(400, 'sawtooth', 0.2); }
}

// --- A.T.L.A.S. OVERSEER ROUTING & ANIMATION ---
function setAtlasState(state) {
    const eye = document.getElementById('atlas-eye');
    const pupil = document.getElementById('atlas-pupil');
    const text = document.getElementById('atlas-status-text');
    
    if(state === 'IDLE') {
        eye.className = "w-16 h-4 border-2 border-[#00FF66] flex items-center justify-center transition-all duration-500";
        pupil.className = "w-2 h-2 bg-[#00FF66] animate-pulse";
        text.innerText = "> STATE: IDLE";
        text.className = "text-xs text-[#00FF66] font-mono font-bold w-full text-left";
    } else if(state === 'PROCESSING') {
        eye.className = "w-24 h-2 border-2 border-[#FF9900] flex items-center justify-center transition-all duration-300";
        pupil.className = "w-12 h-1 bg-[#FF9900] animate-bounce";
        text.innerText = "> STATE: PROCESSING / THINKING";
        text.className = "text-xs text-[#FF9900] font-mono font-bold w-full text-left";
    } else if(state === 'RESPONDING') {
        eye.className = "w-20 h-10 border-2 border-[#00E5FF] flex items-center justify-center transition-all duration-100 rounded-[50%]";
        pupil.className = "w-8 h-8 bg-[#00E5FF] animate-ping rounded-full";
        text.innerText = "> STATE: RESPONDING";
        text.className = "text-xs text-[#00E5FF] font-mono font-bold w-full text-left";
    }
    
    document.getElementById('tel-cog').innerText = Math.floor(Math.random() * 40 + 60) + "%";
    document.getElementById('tel-syn').innerText = Math.floor(Math.random() * 8000 + 2000);
}

async function handleOverseerDirective(e) {
    if (e.key === 'Enter') {
        const input = document.getElementById('overseer-input');
        const term = document.getElementById('overseer-terminal');
        const promptText = input.value.trim();
        if(!promptText) return;

        term.innerHTML += `<div class="text-white mt-2">> USER: ${promptText}</div>`;
        input.value = '';
        term.scrollTop = term.scrollHeight;

        let endpoint = "/api/agent/reach";
        if(promptText.toLowerCase().startsWith("/ody")) endpoint = "/api/odysseus";

        setAtlasState('PROCESSING');
        playBeep(1600, 'sawtooth', 0.2);

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: promptText })
            });
            const data = await res.json();
            
            setAtlasState('RESPONDING');
            playBeep(2400, 'sine', 0.1);
            setTimeout(() => playBeep(2800, 'sine', 0.1), 150);
            
            term.innerHTML += `<div class="text-[#00E5FF] mb-2">${data.response.replace(/\n/g, '<br>')}</div>`;
            term.scrollTop = term.scrollHeight;
            
            setTimeout(() => setAtlasState('IDLE'), 2000);
        } catch (err) {
            setAtlasState('IDLE');
            term.innerHTML += `<div class="text-[#FF0033]">> ERROR: NEURAL LINK SEVERED OR TIMEOUT.</div>`;
        }
        term.scrollTop = term.scrollHeight;
    }
}
// === TAB 4: AP EDITOR LOGIC ===
const apDraftInput = document.getElementById("ap-draft-input");
const wordCountEl = document.getElementById("word-count");
const runAuditBtn = document.getElementById("run-audit-btn");
const auditResults = document.getElementById("audit-results");

if (apDraftInput) {
    // Tier 1: Real-time Word Counter
    apDraftInput.addEventListener("input", (e) => {
        const text = e.target.value.trim();
        const count = text ? text.split(/\s+/).length : 0;
        wordCountEl.innerText = count;
    });
}

if (runAuditBtn) {
    // Tier 2: Deep Newsroom Audit
    runAuditBtn.addEventListener("click", async () => {
        auditResults.innerHTML = "<span style='color: #00ffcc;'>Executing API Deep Scan...</span>";
        
        try {
            const response = await fetch("/api/ap-editor/audit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: apDraftInput.value })
            });
            
            const data = await response.json();
            auditResults.innerHTML = "";
            
            if (data.issues.length === 0) {
                auditResults.innerHTML = "<span style='color: #00ffcc;'>Draft is clean. No AP Style violations detected.</span>";
                return;
            }
            
            data.issues.forEach(issue => {
                const color = issue.severity === "error" ? "#ff9900" : "#ff00ff"; // Orange for Errors, Magenta for Warnings
                auditResults.innerHTML += `
                    <div style="border-left: 2px solid ${color}; padding-left: 10px; margin-bottom: 12px; background: rgba(255, 255, 255, 0.05); padding: 8px;">
                        <strong style="color: ${color};">[${issue.type}]</strong><br/> 
                        ${issue.message}
                    </div>
                `;
            });
        } catch (error) {
            auditResults.innerHTML = "<span style='color: red;'>Audit failed to connect to backend.</span>";
        }
    });
}
// === CORRECTED MODULE 4: AP EDITOR LOGIC ===
const workbenchText = document.getElementById("workbench-text");
const apResults = document.getElementById("ap-results");
const workbenchPreview = document.getElementById("workbench-preview");

// Tier 1: Real-time Word Count & Live Linter Highlights
window.debouncedAPCheck = function() {
    if (!workbenchText || !workbenchPreview) return;
    const text = workbenchText.value;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    
    // Render live text with active highlights (Red for style errors, Orange for weasel words)
    let highlightedText = text
        .replace(/\b(claimed|insinuated|feels|believes)\b/gi, '<span style="background: rgba(255,153,0,0.3); border-bottom: 1px solid #ff9900;" title="Subjective attribution">$&</span>')
        .replace(/\b\d{1,2}:00\s*[ap]\.?m\.?\b/gi, '<span style="background: rgba(255,0,0,0.3); border-bottom: 1px solid #ff0033;" title="AP Style Time Error">$&</span>')
        .replace(/\b\d+\s+percent\b/gi, '<span style="background: rgba(255,0,0,0.3); border-bottom: 1px solid #ff0033;" title="Use % symbol">$&</span>')
        .replace(/\n/g, '<br/>');

    workbenchPreview.innerHTML = `
        <div style="color: #00ffcc; margin-bottom: 10px; font-weight: bold;">[LIVE METRICS] Word Count: ${wordCount}</div>
        <div>${highlightedText}</div>
    `;
};

// Tier 2: Deep Newsroom Audit via Python Backend
window.runAPStyleCheck = async function() {
    if (!workbenchText || !apResults) return;
    
    apResults.innerHTML = "<span style='color: #00ffcc;'>Executing Tier 2 API Deep Scan...</span>";
    
    try {
        const response = await fetch("/api/ap-editor/audit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: workbenchText.value })
        });
        
        const data = await response.json();
        apResults.innerHTML = "";
        
        if (data.issues.length === 0) {
            apResults.innerHTML = "<span style='color: #00ffcc;'>Draft is clean. No AP Style violations detected.</span>";
            return;
        }
        
        data.issues.forEach(issue => {
            const color = issue.severity === "error" ? "#FF0033" : "#FF9900"; // Red for Errors, Orange for Warnings
            apResults.innerHTML += `
                <div style="border-left: 2px solid ${color}; padding-left: 10px; margin-bottom: 8px; background: rgba(255, 255, 255, 0.05); padding: 6px;">
                    <strong style="color: ${color};">[${issue.type}]</strong> ${issue.message}
                </div>
            `;
        });
    } catch (error) {
        apResults.innerHTML = "<span style='color: #FF0033;'>Audit failed to connect to backend.</span>";
    }
};