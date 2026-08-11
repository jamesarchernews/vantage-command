import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
import json
import os

def parse_epub(filename, source_tag):
    if not os.path.exists(filename):
        print(f"⚠️ Warning: '{filename}' not found. Skipping volume.")
        return []

    print(f">> PARSING VOLUME: {source_tag} ({filename})...")
    book = epub.read_epub(filename)
    database = []
    seen_terms = set()

    ap_chapters = [
        "INCLUSIVE STORYTELLING", "ARTIFICIAL INTELLIGENCE", "HEALTH AND SCIENCE", 
        "CRIMINAL JUSTICE", "POLLS AND SURVEYS", "BUSINESS", "TECHNOLOGY", 
        "DIGITAL JOURNALISM", "SOCIAL MEDIA", "DATA JOURNALISM", "RELIGION", 
        "SPORTS", "PUNCTUATION", "CHECKLIST", "NEWS VALUES", "BIBLIOGRAPHY",
        "EDITING", "ETHICS", "FOOD", "FASHION", "LAW", "GENERAL"
    ]

    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_body_content(), 'html.parser')
        
        text_content = soup.get_text(separator='\n\n', strip=True)
        if len(text_content) > 300:
            first_lines = text_content.split('\n')[:3]
            header_text = " ".join(first_lines).strip().upper()
            
            is_chapter = False
            if source_tag == 'STRUNK & WHITE':
                if any(k in header_text for k in ["CHAPTER", "CONTENTS", "ELEMENTS", "RULE", "PRINCIPLE", "INTRODUCTION", "COMPOSITION"]):
                    is_chapter = True
            else:  # AP STYLE
                if any(k in header_text for k in ap_chapters) or len(text_content) > 1200:
                    is_chapter = True

            if is_chapter:
                clean_title = first_lines[0].strip() if len(first_lines[0].strip()) < 50 else header_text[:40]
                guide_title = f"📚 [{source_tag}] CHAPTER: {clean_title.upper()}"
                if guide_title.lower() not in seen_terms:
                    seen_terms.add(guide_title.lower())
                    database.append({
                        "term": guide_title,
                        "rule": text_content,
                        "library": source_tag
                    })
        
        elements = soup.find_all(['p', 'div', 'li', 'dt', 'h3', 'h4'])
        for el in elements:
            strong = el.find(['strong', 'b'])
            span = el.find('span')
            
            headword = ""
            if strong:
                headword = strong.get_text().strip()
            elif span and len(span.get_text().strip()) < 40:
                headword = span.get_text().strip()
            else:
                text = el.get_text().strip()
                parts = text.split('.')
                if len(parts) > 1 and len(parts[0]) < 35:
                    headword = parts[0].strip()

            full_rule = el.get_text().strip()
            
            if (headword 
                and len(headword) < 50 
                and len(full_rule) > len(headword) + 2
                and not headword.isdigit()
                and not headword.startswith("ISBN")
                and not headword.startswith("Published")):
                
                clean_term = headword.lower()
                if clean_term not in seen_terms:
                    seen_terms.add(clean_term)
                    database.append({
                        "term": f"[{source_tag}] {headword}",
                        "rule": full_rule,
                        "library": source_tag
                    })

    print(f">> EXTRACTED {len(database)} ENTRIES FROM {source_tag}")
    return database

def build_master_database():
    master_db = []
    master_db.extend(parse_epub('stylebook.epub', 'AP STYLE'))
    master_db.extend(parse_epub('elements_of_style.epub', 'STRUNK & WHITE'))

    print(f">> MASTER CODEX COMPILED: {len(master_db)} TOTAL ENTRIES.")
    with open('ap_style_database.json', 'w', encoding='utf-8') as f:
        json.dump(master_db, f, indent=2)

if __name__ == '__main__':
    build_master_database()
