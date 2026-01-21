import json
import urllib.request
import requests
from bs4 import BeautifulSoup
import os

def lambda_handler(event, context):
    homepage = event['url']
    max_pages = int(event['max_pages'])
    
    data = {}
    
    opener = urllib.request.build_opener()
    opener.addheaders = [('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')]
    urllib.request.install_opener(opener)

    request_url = urllib.request.urlopen(homepage)
    
    soup = BeautifulSoup(request_url.read(), 'html.parser')
    
    links = []
    crawled = [homepage]
    
    for link in soup.find_all('a', href=True):
        if link['href'] not in links and homepage in link['href'] and link['href'][-4] != "." and link['href'][-5] != ".":
            links.append(link['href'])
    
    while len(data.keys())<max_pages:
        for url in links:
            if url not in crawled and len(data.keys())<max_pages:
                request_url = urllib.request.urlopen(url)
                crawled.append(url)
                try:
                    soup = BeautifulSoup(request_url.read(), 'html.parser')
                    data[url] = {}
                    if request_url.geturl() == url:
                        data[url]['code'] = request_url.status
                        data[url]['title'] = soup.title.string
                    else:
                        data[url]['code'] = requests.get(url).status_code
                        data[url]['title'] = soup.title.string
                    try:
                        value = soup.find_all('meta', attrs={'name': 'description'})[0]
                        if value == "" or value == [[]] or value == []:
                            data[url]['description'] = "None"
                        else:
                            data[url]['description'] = soup.find_all('meta', attrs={'name': 'description'})[0]['content']
                    except:
                        data[url]['description'] = ""
                    try:
                        data[url]['canonical'] = soup.select('link[rel*=canonical]')[0]['href']
                    except:
                        data[url]['canonical'] = ""
                    try:
                        value = soup.find_all('link', rel='alternate', hreflang=True)
                        hreflangs = []
                        for hreflang in value:
                            hreflangs.append(hreflang['hreflang'])
                        if value == []:
                            data[url]['hreflang'] = "None"
                        else:
                            data[url]['hreflang'] = "\n• ".join(hreflangs)
                    except Exception as e:
                        print(e)
                        data[url]['hreflang'] = "None"
                    for link in soup.find_all('a', href=True):
                        if link['href'] not in links and homepage in link['href'] and link['href'][-4] != "." and link['href'][-5] != ".":
                            links.append(link['href'])
                    
                    # Use CSS selectors to exclude common invisible elements:
                    for script in soup(["script", "style"]):
                        script.extract()

                    # Extract text and join with spaces:
                    text_elements = [t.strip() for t in soup.find_all(text=True) if t.strip()]

                    data[url]['word_count'] = len(text_elements)
                            
                    value = soup.find_all('img')
                    if value == "" or value == [[]] or value == []:
                        data[url]['alt_text'] = "None"
                    else:
                        alt_texts = []
                        for image in value:
                            try:
                                alt_text = image.attrs['alt']
                                if alt_text not in alt_texts and alt_text !="":
                                    alt_texts.append(alt_text)
                            except:
                                continue
                    data[url]['alt_text'] = ',<br>'.join(alt_texts)
                    
                    value = soup.find_all('h1')
                    if value == "" or value == [[]] or value == []:
                        data[url]['h1'] = "None"
                    else:
                        h1s = []
                        for header in value:
                            h1 = header.text
                            if h1 not in h1s and h1 !="":
                                h1s.append(h1)
                    data[url]['h1'] = ',<br>'.join(h1s)
                    
                    value = soup.find_all('h2')
                    if value == "" or value == [[]] or value == []:
                        data[url]['h2'] = "None"
                    else:
                        h2s = []
                        for header in value:
                            h2 = header.text
                            if h2 not in h2s and h2 !="":
                                h2s.append(h2)
                    try:
                        data[url]['h2'] = ',<br>'.join(h2s)
                    except:
                        data[url]['h2'] = ""

                    try:
                        #getting GPT to summarise based on page content
                        api_url = "https://api.openai.com/v1/chat/completions"

                        prompt = "Evaluate if this webpage has a good UI/UX. Output 'Good' or 'Bad' with a short summary why. Here is an excerpt of the page HTML: " +str(soup)[:100000]

                        querystring = {"model":"gpt-4o-mini",
                                    "messages":[{"role": "user", "content": prompt}]}

                        openai_key = os.environ.get('OPENAI_API_KEY')
                        headers = {
                            "Content-Type": "application/json",
                            'Authorization': f'Bearer {openai_key}'
                        }

                        response = requests.post(api_url, headers=headers, json=querystring)

                        print(response.json()['choices'][0]['message']['content'])

                        data[url]['uiux'] = response.json()['choices'][0]['message']['content']

                    except Exception as e:
                        print(e)
                        data[url]['uiux'] = ""
                except:
                    continue
                
        
    return {
        'statusCode': 200,
        'body': json.loads(json.dumps(data, default=str))
    }
