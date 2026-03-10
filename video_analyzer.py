import os
import sys
import json
import time
import argparse
import yt_dlp
import google.generativeai as genai
from google.generativeai import types

def extract_video_info(url):
    """Extract metadata and download video using yt-dlp."""
    print(f"[*] Extracting info for: {url}")
    
    # Options for yt-dlp
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': 'downloads/%(uploader)s_%(id)s.%(ext)s',
        'quiet': True,
        'no_warnings': True,
    }
    
    if not os.path.exists('downloads'):
        os.makedirs('downloads')
        
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            
            # If the extension changed (e.g. mkv to mp4), find the actual file
            if not os.path.exists(filename):
                base = os.path.splitext(filename)[0]
                for ext in ['mp4', 'mkv', 'webm']:
                    if os.path.exists(f"{base}.{ext}"):
                        filename = f"{base}.{ext}"
                        break
            
            return {
                'title': info.get('title', 'No Title'),
                'uploader': info.get('uploader', 'Unknown'),
                'description': info.get('description', ''),
                'timestamp': info.get('upload_date', ''),
                'video_path': filename,
                'url': url
            }
    except Exception as e:
        print(f"[!] Error extracting video: {e}")
        return None

def upload_to_gemini(path, mime_type="video/mp4"):
    """Upload file to Gemini File API."""
    print(f"[*] Uploading {path} to Gemini...")
    file = genai.upload_file(path=path, mime_type=mime_type)
    print(f"[*] File uploaded: {file.uri}")
    return file

def wait_for_files_active(files):
    """Wait for uploaded files to be processed."""
    print("[*] Waiting for file processing...")
    for name in (f.name for f in files):
        file = genai.get_file(name)
        while file.state.name == "PROCESSING":
            print(".", end="", flush=True)
            time.sleep(5)
            file = genai.get_file(name)
        if file.state.name != "ACTIVE":
            raise Exception(f"File {file.name} failed to process")
    print("\n[*] File ready.")

def analyze_video(api_key, video_info, prompt):
    """Send video to Gemini for analysis."""
    genai.configure(api_key=api_key)
    
    # Check if file exists
    if not video_info or not os.path.exists(video_info['video_path']):
        return "Video file not found or extraction failed."
    
    try:
        # Upload
        video_file = upload_to_gemini(video_info['video_path'])
        wait_for_files_active([video_file])
        
        # Model selection - using 1.5-flash for speed and cost
        model = genai.GenerativeModel(model_name="gemini-1.5-flash")
        
        full_prompt = f"{prompt}\n\nMetadata:\nHandle: {video_info['uploader']}\nCaption: {video_info['description']}\nURL: {video_info['url']}"
        
        print("[*] Generating analysis...")
        response = model.generate_content([video_file, full_prompt], request_options={"timeout": 600})
        
        return response.text
    except Exception as e:
        return f"Analysis failed: {e}"

def main():
    parser = argparse.ArgumentParser(description="Automated Video Analyzer using Gemini")
    parser.add_argument("--url", required=True, help="Profile or Video URL")
    parser.add_argument("--key", help="Gemini API Key (or set GOOGLE_API_KEY env var)")
    parser.add_argument("--prompt", default="Describe the content of this video, determine the main topic, and analyze the sentiment of the caption.", help="Analysis prompt")
    
    args = parser.parse_args()
    
    api_key = args.key or os.environ.get('GOOGLE_API_KEY')
    if not api_key:
        print("[!] Error: Gemini API Key is required. Provide via --key or GOOGLE_API_KEY environment variable.")
        sys.exit(1)
        
    video_info = extract_video_info(args.url)
    if not video_info:
        print("[!] Failed to process video.")
        sys.exit(1)
        
    result = analyze_video(api_key, video_info, args.prompt)
    
    print("\n" + "="*50)
    print("ANALYSIS RESULT")
    print("="*50)
    print(result)
    print("="*50)

if __name__ == "__main__":
    main()
