# BUILD: 008.2
import asyncio
import json
import random
import httpx
import io
import os
import re
import piexif
import language_tool_python
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="OSINT TACTICAL COMMAND", version="0.0.8")
app.mount("/static", StaticFiles(directory="static"), name="static")

try:
    grammar_tool = language_tool_python.LanguageToolPublicAPI('en-US')
except Exception as e:
    grammar_tool = None

os.makedirs("local_storage/notes", exist_ok=True)
os.makedirs("local_storage/vault", exist_ok=True)
VAULT_FILE = "local_storage/vault/source_vault.json"
AP_DB_FILE = "ap_style_database.json"

if not os.path.exists(VAULT_FILE):
    with open(VAULT_FILE, "w", encoding="utf-8") as f: json.dump([], f)

ap_style_db = []
if os.path.exists(AP_DB_FILE):
    with open(AP_DB_FILE, "r", encoding="utf-8") as f: 
        ap_style_db = json.load(f)

live_cad_dispatches = []
CA_BBOX = {"lamin": 32.0, "lamax": 42.0, "lomin": -124.0, "lomax": -114.0}

async def fetch_osint_data():
    payload = {"build": "008.2", "air_traffic": [], "seismic": [], "emergencies": []}
    global live_cad_dispatches
    payload["emergencies"].extend(live_cad_dispatches)
    live_cad_dispatches = [] 
    
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            url_air = f"https://opensky-network.org/api/states/all?lamin={CA_BBOX['lamin']}&lamax={CA_BBOX['lamax']}&lomin={CA_BBOX['lomin']}&lomax={CA_BBOX['lomax']}"
            res_air = await client.get(url_air)
            if res_air.status_code == 200:
                for s in (res_air.json().get("states") or [])[:50]:
                    if s[5] and s[6] and s[7]:
                        payload["air_traffic"].append({"coords": [s[5], s[6], min(s[7], 12000)], "callsign": s[1].strip() if s[1] else "NAV-VECTOR", "heading": s[10] or 0})
            else: raise Exception("Rate Limited")
        except Exception:
            for _ in range(12):
                payload["air_traffic"].append({"coords": [-118.24 + random.uniform(-0.8, 0.8), 34.05 + random.uniform(-0.8, 0.8), random.randint(1000, 10000)], "callsign": f"SIM-{random.randint(100,999)}", "simulated": True})

        try:
            res_eq = await client.get("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson")
            if res_eq.status_code == 200:
                for f in res_eq.json().get("features", []):
                    coords, mag = f["geometry"]["coordinates"], f["properties"]["mag"]
                    if -124.0 <= coords[0] <= -114.0 and 32.0 <= coords[1] <= 42.0:
                        payload["seismic"].append({"id": f["id"], "coords": [coords[0], coords[1]], "mag": mag})
        except Exception: pass

        try:
            res_nws = await client.get("https://api.weather.gov/alerts/active?area=CA", headers={"User-Agent": "VantageCommand/1.0"})
            if res_nws.status_code == 200:
                for a in res_nws.json().get("features", [])[:10]:
                    event_type = a.get("properties", {}).get("event", "HAZARD").upper()
                    if "FLOOD" in event_type or "SURF" in event_type: continue 
                    payload["emergencies"].append({"coords": [-118.24 + random.uniform(-0.4, 0.4), 34.05 + random.uniform(-0.4, 0.4)], "type": f"NWS: {event_type}", "threat": "AMBER"})
        except Exception: pass

    return payload

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_text(json.dumps(await fetch_osint_data()))
            await asyncio.sleep(3.5)
    except WebSocketDisconnect: pass

@app.post("/api/save-note")
async def save_note(request: Request):
    data = await request.json()
    filename = f"local_storage/notes/Field_Log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    with open(filename, "w", encoding="utf-8") as f: f.write(data.get("content", ""))
    return {"status": "success", "file": filename}

@app.get("/api/vault")
async def get_vault():
    with open(VAULT_FILE, "r", encoding="utf-8") as f: return json.load(f)

@app.post("/api/vault")
async def add_to_vault(request: Request):
    data = await request.json()
    with open(VAULT_FILE, "r", encoding="utf-8") as f: vault = json.load(f)
    vault.append(data)
    with open(VAULT_FILE, "w", encoding="utf-8") as f: json.dump(vault, f)
    return {"status": "success"}

@app.post("/api/scrub-exif")
async def scrub_exif(file: UploadFile = File(...)):
    img_bytes = await file.read()
    try:
        clean = io.BytesIO()
        piexif.remove(img_bytes, clean)
        clean.seek(0)
        return StreamingResponse(clean, media_type="image/jpeg", headers={"Content-Disposition": f"attachment; filename=CLEANED_{file.filename}"})
    except Exception: return {"error": "Could not scrub EXIF."}

@app.get("/api/stylebook/search")
async def search_stylebook(q: str = ""):
    query = q.lower()
    if not query or len(query) < 2: return {"results": ap_style_db[:20]} 
    return {"results": [entry for entry in ap_style_db if query in entry["term"].lower() or query in entry["rule"].lower()][:30]}

@app.get("/api/stylebook/all")
async def get_all_stylebook():
    return {"database": sorted(ap_style_db, key=lambda x: x['term'].lower())}

@app.post("/api/check-style")
async def check_style(request: Request):
    text = (await request.json()).get("text", "")
    flags = []
    red_flags = [{"pattern": r"(?i)\b(yesterday|today|tomorrow)\b", "suggestion": "Use specific day of week.", "type": "AP Rule: Dates"}]
    for rule in red_flags:
        for match in re.finditer(rule["pattern"], text): flags.append({"type": rule["type"], "error": match.group(0), "suggestion": rule["suggestion"], "category": "AP Style"})

    words_in_text = set(re.findall(r'\b\w+\b', text.lower()))
    for entry in ap_style_db:
        term_lower = entry["term"].lower()
        if " " not in term_lower:
            if term_lower in words_in_text: flags.append({"type": f"Reference: {entry['term']}", "error": entry["term"], "suggestion": entry["rule"], "category": "AP Style"})
        else:
            if re.search(rf"\b{re.escape(term_lower)}\b", text.lower()): flags.append({"type": f"Reference: {entry['term']}", "error": entry["term"], "suggestion": entry["rule"], "category": "AP Style"})

    if grammar_tool:
        try:
            for m in grammar_tool.check(text)[:10]: flags.append({"type": "Syntax / Grammar", "error": m.context[m.offset:m.offset+m.errorLength], "suggestion": f"{m.message} (Try: {', '.join(m.replacements[:3])})", "category": "Grammar"})
        except Exception: pass

    return {"flags": flags}

@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    from faster_whisper import WhisperModel
    model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(io.BytesIO(await file.read()), beam_size=5)
    return {"transcript": [{"start": s.start, "end": s.end, "text": s.text} for s in segments]}

@app.get("/", response_class=HTMLResponse)
async def read_root():
    with open("index.html", "r", encoding="utf-8") as f: return f.read()
