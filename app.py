# BUILD: 015.2 (CODEX CROSS-REFERENCING & JOURNALISM LINTER ENGINE)
import asyncio
import json
import random
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

app = FastAPI(title="OSINT TACTICAL COMMAND", version="015.2")
app.mount("/static", StaticFiles(directory="static"), name="static")

AP_DB_FILE = "ap_style_database.json"

ap_style_db = []
if os.path.exists(AP_DB_FILE):
    with open(AP_DB_FILE, "r", encoding="utf-8") as f: 
        ap_style_db = json.load(f)

live_cad_dispatches = []
LA_BBOX = {"lamin": 33.5, "lamax": 34.5, "lomin": -118.8, "lomax": -117.5}
CA_BBOX = {"lamin": 32.0, "lamax": 42.0, "lomin": -124.0, "lomax": -114.0}

cached_alpr_nodes = []
alpr_last_fetched = 0

async def fetch_alpr_data(client):
    global cached_alpr_nodes, alpr_last_fetched
    if time.time() - alpr_last_fetched > 3600:
        nodes = []
        try:
            flock_url = "https://raw.githubusercontent.com/Ringmast4r/FLOCK/main/camera_networks.json"
            res_flock = await client.get(flock_url, timeout=15.0)
            if res_flock.status_code == 200:
                data = res_flock.json()
                if "features" in data:
                    for f in data["features"]:
                        coords = f.get("geometry", {}).get("coordinates", [0,0])
                        if LA_BBOX["lomin"] <= coords[0] <= LA_BBOX["lomax"] and LA_BBOX["lamin"] <= coords[1] <= LA_BBOX["lamax"]:
                            nodes.append({"coords": [coords[0], coords[1]], "type": "ALPR NODE (FLOCK-NET)", "operator": "NETWORKED ALPR"})
        except Exception: pass

        try:
            overpass_url = "https://overpass-api.de/api/interpreter"
            query = f"""
            [out:json][timeout:25];
            (node["man_made"="surveillance"]({LA_BBOX['lamin']},{LA_BBOX['lomin']},{LA_BBOX['lamax']},{LA_BBOX['lomax']}););
            out body;
            """
            res_osm = await client.post(overpass_url, data={'data': query})
            if res_osm.status_code == 200:
                for element in res_osm.json().get("elements", []):
                    tags = element.get("tags", {})
                    is_alpr = tags.get("surveillance:type") == "ALPR" or tags.get("camera:type") == "alpr"
                    nodes.append({"coords": [element["lon"], element["lat"]], "type": "ALPR NODE" if is_alpr else "SURVEILLANCE CAM", "operator": tags.get("operator", "MUNICIPAL")})
        except Exception: pass

        if not nodes:
            operators = ["Flock Safety", "Motorola/Vigilant", "Genetec", "LAPD"]
            for _ in range(400):  
                nodes.append({"coords": [-118.24 + random.uniform(-0.5, 0.5), 34.05 + random.uniform(-0.4, 0.4)], "type": "ALPR NODE (FALLBACK)", "operator": random.choice(operators)})

        cached_alpr_nodes = nodes
        alpr_last_fetched = time.time()
                
    return cached_alpr_nodes

async def fetch_osint_data():
    payload = {"build": "015.2", "air_traffic": [], "seismic": [], "emergencies": [], "surveillance_nodes": []}
    global live_cad_dispatches
    payload["emergencies"].extend(live_cad_dispatches)
    live_cad_dispatches = [] 
    
    async with httpx.AsyncClient(timeout=4.0) as client:
        payload["surveillance_nodes"] = await fetch_alpr_data(client)

        try:
            url_air = f"https://opensky-network.org/api/states/all?lamin={CA_BBOX['lamin']}&lamax={CA_BBOX['lamax']}&lomin={CA_BBOX['lomin']}&lomax={CA_BBOX['lomax']}"
            res_air = await client.get(url_air)
            if res_air.status_code == 200:
                for s in (res_air.json().get("states") or [])[:50]:
                    if s[5] and s[6] and s[7]:
                        payload["air_traffic"].append({"coords": [s[5], s[6], min(s[7], 12000)], "callsign": s[1].strip() if s[1] else "NAV-VECTOR", "heading": s[10] or 0})
        except Exception: pass

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
                    if "FLOOD" not in event_type and "SURF" not in event_type:
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

# [ TAB 6 A.T.L.A.S. OVERSEER ROUTING ]
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

# [ UTILITIES ]
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

# [ ADVANCED JOURNALISM & CODEX LINTER ENGINE ]
@app.post("/api/check-style")
async def check_style(request: Request):
    text = (await request.json()).get("text", "")
    if not text.strip():
        return {"flags": [], "original_text": ""}

    flags = []

    # 1. Contraction & Punctuation Engine
    contractions_map = {
        "thats": "that's", "shed": "she'd", "hed": "he'd", "youre": "you're", "theyre": "they're",
        "were": "we're", "whats": "what's", "theres": "there's", "cant": "can't", "wont": "won't",
        "dont": "don't", "isnt": "isn't", "arent": "aren't", "wasnt": "wasn't", "werent": "weren't",
        "havent": "haven't", "hasnt": "hasn't", "couldnt": "couldn't", "wouldnt": "wouldn't",
        "shouldnt": "shouldn't", "couldve": "could've", "wouldve": "would've", "shouldve": "should've"
    }
    for bad_c, fix_c in contractions_map.items():
        for match in re.finditer(rf"\b({bad_c})\b", text, re.IGNORECASE):
            flags.append({
                "type": "Punctuation / Contraction",
                "error": match.group(0),
                "suggestion": f"Missing apostrophe. Replace with '{fix_c}'.",
                "level": "red"
            })

    # 2. Journalistic Prose & AP Style Mechanics Rules (Inspired by claude-skills-journalism)
    journalism_rules = [
        (r"\b(dogwalker|dog-walker)\b", "AP Style requires two words: 'dog walker'.", "red"),
        (r"\b(white house)\b", "AP Style requires capitalization: 'White House'.", "red"),
        (r"\b(congress|senate|supreme court|dodgers|lapd|fbi|cia)\b", "Proper noun/agency capitalization required.", "red"),
        (r"\b(yesterday|today|tomorrow|yesturday|yestarday)\b", "AP Style: Avoid relative dates like 'yesterday'. Use specific day of week (e.g., Monday).", "amber"),
        (r"\b(am|is|are|was|were|be|been|being)\s+([a-z]+ed)\b", "Passive voice detected. Revise for active voice.", "amber"),
        (r"\b(1|2|3|4|5|6|7|8|9)\b", "AP Style: Spell out whole numbers below 10 (one through nine).", "red"),
        (r"\b(due to the fact that)\b", "Journalistic Conciseness: Replace with 'because'.", "amber"),
        (r"\b(at this point in time)\b", "Journalistic Conciseness: Replace with 'now' or 'currently'.", "amber"),
        (r"\b(close proximity)\b", "Redundancy: Use 'near' or 'close'.", "amber"),
        (r"\b(sources say|some people say|it is believed)\b", "Attribution Check: Name specific sources or official reporting.", "amber")
    ]
    for pattern, suggestion, level in journalism_rules:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            flags.append({
                "type": "AP / Journalistic Linter",
                "error": match.group(0),
                "suggestion": suggestion,
                "level": level
            })

    # 3. Terminal Sentence Punctuation Check
    if text.strip() and text.strip()[-1] not in '.!?"\'':
        last_word = text.strip().split()[-1]
        flags.append({
            "type": "Terminal Punctuation",
            "error": last_word,
            "suggestion": "Sentence lacks ending punctuation (period, question mark, or quote).",
            "level": "amber"
        })

    # 4. Deep Codex Database Cross-Referencer
    text_lower = text.lower()
    for entry in ap_style_db:
        term = entry.get("term", "").strip()
        rule = entry.get("rule", "").strip()
        
        # Skip generic folder headers
        if not term or "CHAPTER:" in term.upper() or term.startswith("★") or term.startswith("["):
            continue
            
        clean_term = term.lower()
        if len(clean_term) >= 3 and clean_term in text_lower:
            matches = re.finditer(rf"\b{re.escape(clean_term)}\b", text, re.IGNORECASE)
            for m in matches:
                flags.append({
                    "type": f"Codex Rule: {term}",
                    "error": m.group(0),
                    "suggestion": rule if rule else "Verify against AP Style Codex guidelines.",
                    "level": "red"
                })

    # Deduplicate flags by matched text span
    seen = set()
    unique_flags = []
    for f in flags:
        key = f["error"].lower()
        if key not in seen:
            seen.add(key)
            unique_flags.append(f)

    return {"flags": unique_flags, "original_text": text}

@app.get("/", response_class=HTMLResponse)
async def read_root():
    with open("index.html", "r", encoding="utf-8") as f: return f.read()