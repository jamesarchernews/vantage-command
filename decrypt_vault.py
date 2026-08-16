import json
import sys
import getpass
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

def decrypt_file(enc_path: str, password: str) -> str:
    with open(enc_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    
    salt = bytes(payload["salt"])
    iv = bytes(payload["iv"])
    data = bytes(payload["data"])
    
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    key = kdf.derive(password.encode("utf-8"))
    
    aesgcm = AESGCM(key)
    decrypted_bytes = aesgcm.decrypt(iv, data, None)
    return decrypted_bytes.decode("utf-8")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: ./venv/bin/python decrypt_vault.py <file.enc>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    pwd = getpass.getpass("Enter decryption passphrase: ")
    
    try:
        plaintext = decrypt_file(file_path, pwd)
        print("\n--- DECRYPTED PAYLOAD ---")
        print(plaintext)
        print("-------------------------\n")
    except Exception as e:
        print(f"\n❌ Decryption Failed: Invalid passphrase or corrupted file ({e}).")