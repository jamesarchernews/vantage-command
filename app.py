# BUILD: 016.0 (AUTHENTIC OSINT DATA PIPELINE & LAYER MATRIX)
import asyncio
import json
import httpx
import io
import os
import re
import time
import piexif
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="OSINT TACTICAL COMMAND", version="016.0")
app.mount("/static", StaticFiles(directory="static"), name="static")

AP_DB_FILE = "ap_style_database.json"
ap_style_db = []
if os.path.exists(AP_DB_FILE):
    with open(AP_DB_FILE, "r", encoding="utf-8") as f: 
        ap_style_db = json.load(f)

live_cad_dispatches = []
LA_BBOX = {"lamin": 33.5, "lamax": 34.5, "lomin": -118.8, "lomax": -117.5}
CA_BBOX = {"lamin": 32.0, "lamax": 42.0, "lomin": -124.0, "lomax": -114.0}

# Authentic Data Caches
cache_time = {'alpr': 0, 'surv': 0, 'dc': 0, 'gnss': 0}
caches = {'alpr': [], 'surv': [], 'dc': [], 'gnss': []}

def filter_la(lon, lat):
    try:
        return LA_BBOX["lomin"] <= float(lon) <= LA_BBOX["lomax"] and LA_BBOX["lamin"] <= float(lat) <= LA_BBOX["lamax"]
    except: return False

async def fetch_github_geojson(client, url, default_type, operator_field="operator"):
    nodes = []
    try:
        res = await client.get(url, timeout=10.0)
        if res.status_code == 200:
            data = res.json()
            features = data.get("features", []) if isinstance(data, dict) else data
            for f in features:
                if isinstance(f, dict):
                    geom = f.get("geometry", {})
                    props = f.get("properties", {})
                    if geom and geom.get("type") == "Point":
                        coords = geom.get("coordinates", [0, 0])
                        if filter_la(coords[0], coords[1]):
                            nodes.append({"coords": [coords[0], coords[1]], "type": props.get("type", default_type), "operator": props.get(operator_field, "UNKNOWN"), "name": props.get("name", "N/A")})
                    elif "lat" in f or "latitude" in f:
                        lat = f.get("lat") or f.get("latitude")
                        lon = f.get("lon") or f.get("lng") or f.get("longitude")
                        if filter_la(lon, lat):
                            nodes.append({"coords": [float(lon), float(lat)], "type": f.get("type", default_type), "operator": f.get(operator_field, "UNKNOWN"), "name": f.get("name", "N/A")})
    except Exception: pass
    return nodes

async def update_caches(client):
    now = time.time()
    
    # 1. ALPR Network Update
    if now - cache_time['alpr'] > 3600:
        nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/FLOCK/main/camera_networks.geojson", "ALPR NODE (FLOCK)", "operator")
        if not nodes: nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/FLOCK/main/camera_networks.json", "ALPR NODE", "operator")
        if not nodes: # Authentic Overpass Fallback
            try:
                q = f"""[out:json][timeout:15];(node["man_made"="surveillance"]["surveillance:type"="ALPR"]({LA_BBOX['lamin']},{LA_BBOX['lomin']},{LA_BBOX['lamax']},{LA_BBOX['lomax']}); node["camera:type"="alpr"]({LA_BBOX['lamin']},{LA_BBOX['lomin']},{LA_BBOX['lamax']},{LA_BBOX['lomax']}););out body;"""
                res = await client.post("https://overpass-api.de/api/interpreter", data={'data': q}, timeout=15)
                if res.status_code == 200:
                    for el in res.json().get("elements", []): nodes.append({"coords": [el["lon"], el["lat"]], "type": "ALPR NODE", "operator": el.get("tags", {}).get("operator", "NETWORKED ALPR"), "name": el.get("tags", {}).get("name", "ALPR CAM")})
            except: pass
        if nodes: caches['alpr'] = nodes; cache_time['alpr'] = now

    # 2. Data Centers Update
    if now - cache_time['dc'] > 3600:
        nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/Global-Data-Center-Map/main/datacenters.geojson", "DATA CENTER", "operator")
        if not nodes: nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/Global-Data-Center-Map/main/datacenters.json", "DATA CENTER", "operator")
        if not nodes:
            try:
                q = f"""[out:json][timeout:15];(node["telecom"="data_center"]({LA_BBOX['lamin']},{LA_BBOX['lomin']},{LA_BBOX['lamax']},{LA_BBOX['lomax']}););out body;"""
                res = await client.post("https://overpass-api.de/api/interpreter", data={'data': q}, timeout=15)
                if res.status_code == 200:
                    for el in res.json().get("elements", []): nodes.append({"coords": [el["lon"], el["lat"]], "type": "DATA CENTER / IXP", "operator": el.get("tags", {}).get("operator", "IXP HUB"), "name": el.get("tags", {}).get("name", "FACILITY")})
            except: pass
        if nodes: caches['dc'] = nodes; cache_time['dc'] = now

    # 3. Surveillance Update
    if now - cache_time['surv'] > 3600:
        nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/surveillance-capabilities-map/main/map_data.geojson", "SURVEILLANCE NODE", "agency")
        if not nodes: nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/surveillance-capabilities-map/main/cameras.json", "SURVEILLANCE NODE", "agency")
        if not nodes:
            try:
                q = f"""[out:json][timeout:15];(node["man_made"="surveillance"]({LA_BBOX['lamin']},{LA_BBOX['lomin']},{LA_BBOX['lamax']},{LA_BBOX['lomax']}););out body;"""
                res = await client.post("https://overpass-api.de/api/interpreter", data={'data': q}, timeout=15)
                if res.status_code == 200:
                    for el in res.json().get("elements", []):
                        if el.get("tags", {}).get("surveillance:type") != "ALPR" and el.get("tags", {}).get("camera:type") != "alpr":
                            nodes.append({"coords": [el["lon"], el["lat"]], "type": "SURVEILLANCE CCTV", "operator": el.get("tags", {}).get("operator", "MUNICIPAL"), "name": el.get("tags", {}).get("name", "CCTV NODE")})
            except: pass
        if nodes: caches['surv'] = nodes; cache_time['surv'] = now

    # 4. GNSS Timing Nodes Update
    if now - cache_time['gnss'] > 3600:
        nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/GNSS/main/stations.geojson", "GNSS REFERENCE", "network")
        if not nodes: nodes = await fetch_github_geojson(client, "https://raw.githubusercontent.com/Ringmast4r/GNSS/main/stations.json", "GNSS REFERENCE", "network")
        if not nodes:
            try:
                q = f"""[out:json][timeout:15];(node["man_made"="communications_tower"]({LA_BBOX['lamin']},{LA_BBOX['lomin']},{LA_BBOX['lamax']},{LA_BBOX['lomax']}););out body;"""
                res = await client.post("https://overpass-api.de/api/interpreter", data={'data': q}, timeout=15)
                if res.status_code == 200:
                    for el in res.json().get("elements", []): nodes.append({"coords": [el["lon"], el["lat"]], "type": "COMMS TOWER / GNSS", "operator": el.get("tags", {}).get("operator", "NETWORK"), "name": el.get("tags", {}).get("name", "REFERENCE NODE")})
            except: pass
        if nodes: caches['gnss'] = nodes; cache_time['gnss'] = now

async def fetch_osint_data():
    global live_cad_dispatches
    payload = {
        "build": "016.0", 
        "air_traffic": [], 
        "seismic": [], 
        "emergencies": list(live_cad_dispatches),
        "alpr_nodes": caches['alpr'],
        "surv_nodes": caches['surv'],
        "dc_nodes": caches['dc'],
        "gnss_nodes": caches['gnss']
    }
    live_cad_dispatches.clear()
    
    async with httpx.AsyncClient(timeout=4.0) as client:
        await update_caches(client)
        payload.update({"alpr_nodes": caches['alpr'], "surv_nodes": caches['surv'], "dc_nodes": caches['dc'], "gnss_nodes": caches['gnss']})

        try:
            res_air = await client.get(f"https://opensky-network.org/api/states/all?lamin={CA_BBOX['lamin']}&lamax={CA_BBOX['lamax']}&lomin={CA_BBOX['lomin']}&lomax={CA_BBOX['lomax']}")
            if res_air.status_code == 200:
                for s in (res_air.json().get("states") or [])[:50]:
                    if s[5] and s[6] and s[7]: payload["air_traffic"].append({"coords": [s[5], s[6], min(s[7], 12000)], "callsign": s[1].strip() if s[1] else "NAV-VECTOR", "heading": s[10] or 0})
        except: pass

        try:
            res_nws = await client.get("https://api.weather.gov/alerts/active?area=CA", headers={"User-Agent": "VantageCommand/1.0"})
            if res_nws.status_code == 200:
                for a in res_nws.json().get("features", [])[:10]:
                    event_type = a.get("properties", {}).get("event", "HAZARD").upper()
                    if "FLOOD" not in event_type and "SURF" not in event_type:
                        payload["emergencies"].append({"coords": [-118.24, 34.05], "type": f"NWS: {event_type}", "threat": "AMBER"})
        except: pass

    return payload

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_text(json.dumps(await fetch_osint_data()))
            await asyncio.sleep(3.5)
    except WebSocketDisconnect: pass

@app.post("/api/agent/reach")
async def agent_reach(request: Request):
    payload = await request.json()
    await asyncio.sleep(1.2) 
    return {"agent": "AGENT-REACH", "response": f">> DIRECTIVE ACKNOWLEDGED: {payload.get('prompt')} \n>> STANDING BY FOR ADDITIONAL PARAMETERS."}

@app.post("/api/odysseus")
async def odysseus_endpoint(request: Request):
    payload = await request.json()
    await asyncio.sleep(1.5)
    return {"agent": "ODYSSEUS", "response": f">> ANALYSIS COMPLETE FOR: {payload.get('prompt')} \n>> DATA ASSIMILATED INTO NETWORK."}

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
async def get_all_stylebook(): return {"database": sorted(ap_style_db, key=lambda x: x['term'].lower())}

@app.post("/api/check-style")
async def check_style(request: Request):
    text = (await request.json()).get("text", "")
    if not text.strip(): return {"flags": [], "original_text": ""}

    flags = []
    contractions_map = {"thats": "that's", "shed": "she'd", "hed": "he'd", "youre": "you're", "theyre": "they're", "were": "we're", "whats": "what's", "theres": "there's", "cant": "can't", "wont": "won't", "dont": "don't", "isnt": "isn't", "arent": "aren't", "wasnt": "wasn't", "werent": "weren't", "havent": "haven't", "hasnt": "hasn't", "couldnt": "couldn't", "wouldnt": "wouldn't", "shouldnt": "shouldn't", "couldve": "could've", "wouldve": "would've", "shouldve": "should've"}
    for bad_c, fix_c in contractions_map.items():
        for match in re.finditer(rf"\b({bad_c})\b", text, re.IGNORECASE): flags.append({"type": "Punctuation / Contraction", "error": match.group(0), "suggestion": f"Missing apostrophe. Replace with '{fix_c}'.", "level": "red"})

    journalism_rules = [(r"\b(dogwalker|dog-walker)\b", "AP Style requires two words: 'dog walker'.", "red"), (r"\b(white house)\b", "AP Style requires capitalization: 'White House'.", "red"), (r"\b(congress|senate|supreme court|dodgers|lapd|fbi|cia)\b", "Proper noun/agency capitalization required.", "red"), (r"\b(yesterday|today|tomorrow|yesturday|yestarday)\b", "AP Style: Avoid relative dates like 'yesterday'. Use specific day of week (e.g., Monday).", "amber"), (r"\b(am|is|are|was|were|be|been|being)\s+([a-z]+ed)\b", "Passive voice detected. Revise for active voice.", "amber"), (r"\b(1|2|3|4|5|6|7|8|9)\b", "AP Style: Spell out whole numbers below 10 (one through nine).", "red"), (r"\b(due to the fact that)\b", "Journalistic Conciseness: Replace with 'because'.", "amber"), (r"\b(at this point in time)\b", "Journalistic Conciseness: Replace with 'now' or 'currently'.", "amber"), (r"\b(close proximity)\b", "Redundancy: Use 'near' or 'close'.", "amber"), (r"\b(sources say|some people say|it is believed)\b", "Attribution Check: Name specific sources or official reporting.", "amber")]
    for pattern, suggestion, level in journalism_rules:
        for match in re.finditer(pattern, text, re.IGNORECASE): flags.append({"type": "AP / Journalistic Linter", "error": match.group(0), "suggestion": suggestion, "level": level})

    if text.strip() and text.strip()[-1] not in '.!?"\'': flags.append({"type": "Terminal Punctuation", "error": text.strip().split()[-1], "suggestion": "Sentence lacks ending punctuation.", "level": "amber"})

    text_lower = text.lower()
    for entry in ap_style_db:
        term = entry.get("term", "").strip()
        rule = entry.get("rule", "").strip()
        if not term or "CHAPTER:" in term.upper() or term.startswith("★") or term.startswith("["): continue
        clean_term = term.lower()
        if len(clean_term) >= 3 and clean_term in text_lower:
            matches = re.finditer(rf"\b{re.escape(clean_term)}\b", text, re.IGNORECASE)
            for m in matches: flags.append({"type": f"Codex Rule: {term}", "error": m.group(0), "suggestion": rule if rule else "Verify against AP Style Codex guidelines.", "level": "red"})

    seen = set()
    unique_flags = []
    for f in flags:
        key = f["error"].lower()
        if key not in seen: seen.add(key); unique_flags.append(f)

    return {"flags": unique_flags, "original_text": text}

@app.get("/", response_class=HTMLResponse)
async def read_root():
    with open("index.html", "r", encoding="utf-8") as f: return f.read()