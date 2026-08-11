import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
import json
import os

def build_database():
    print(">> RUNNING CHAPTER-AWARE EPUB PARSER...")
    epub_path = 'stylebook.epub'
    if not os.path.exists(epub_path) and os.path.exists('vantage_env/stylebook.epub'):
        epub_path = 'vantage_env/stylebook.epub'
        
    try:
        book = epub.read_epub(epub_path)
    except Exception as e:
        print(f"❌ Could not open '{epub_path}': {e}")
        return

    database = []
    seen_terms = set()

    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_body_content(), 'html.parser')
        
        # Determine Chapter Title from header tags
        chapter_title = "GENERAL REFERENCE"
        h1 = soup.find(['h1', 'h2'])
        if h1:
            chapter_title = h1.get_text().strip().upper()
        else:
            first_p = soup.find('p')
            if first_p:
                chapter_title = first_p.get_text().strip()[:40].upper()

        # Clean up chapter title for indexing
        if len(chapter_title) > 50 or not chapter_title:
            chapter_title = "TEXTBOOK CHAPTER"

        # Extract sub-sections split by headers or strong tags within the chapter
        sections = soup.find_all(['h3', 'h4', 'dt'])
        if sections:
            for sec in sections:
                sub_title = sec.get_text().strip()
                # Gather text until next header
                body_text = ""
                curr = sec.find_next_sibling()
                while curr and curr.name not in ['h3', 'h4', 'dt', 'h1', 'h2']:
                    body_text += curr.get_text(separator=' ', strip=True) + "\n\n"
                    curr = curr.find_next_sibling()

                if sub_title and len(body_text.strip()) > 50:
                    entry_name = f"📖 {chapter_title} // {sub_title.upper()}"
                    if entry_name.lower() not in seen_terms:
                        seen_terms.add(entry_name.lower())
                        database.append({
                            "term": entry_name,
                            "rule": body_text.strip()
                        })

        # Fallback: Capture full chapter text if no sub-sections found
        full_text = soup.get_text(separator='\n\n', strip=True)
        if len(full_text) > 300:
            full_entry_name = f"📖 CHAPTER: {chapter_title}"
            if full_entry_name.lower() not in seen_terms:
                seen_terms.add(full_entry_name.lower())
                database.append({
                    "term": full_entry_name,
                    "rule": full_text
                })

        # Standard A-Z Dictionary Term Extraction
        for p in soup.find_all(['p', 'li']):
            strong = p.find(['strong', 'b'])
            span = p.find('span')
            
            headword = ""
            if strong:
                headword = strong.get_text().strip()
            elif span and len(span.get_text().strip()) < 40:
                headword = span.get_text().strip()

            full_rule = p.get_text().strip()
            
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
                        "term": headword,
                        "rule": full_rule
                    })

    print(f">> EXTRACTED {len(database)} TOTAL BROWSABLE ENTRIES & CHAPTERS!")
    with open('ap_style_database.json', 'w', encoding='utf-8') as f:
        json.dump(database, f, indent=2)

if __name__ == '__main__':
    build_database()
