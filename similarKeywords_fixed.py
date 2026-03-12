import json
import os
import requests
from pymongo.mongo_client import MongoClient
from pymongo.server_api import ServerApi
from datetime import datetime
from pytz import timezone

def lambda_handler(event, context):
    print("Received event:", event)
    pacific = timezone("Asia/Singapore")
    local_datetime = pacific.localize(datetime.today())

    uri = "mongodb+srv://kenneth:S8942769z@digimetrics.gns7b.mongodb.net/?retryWrites=true&w=majority&appName=digimetrics"
    client = MongoClient(uri)
    database = client["keywords"]
    collection = database["search_vol"]

    user = event.get('user', "")
    keywords_input = event.get('keywords', [])
    if isinstance(keywords_input, str):
        keywords_input = [keywords_input]
    
    location = event.get('location')
    language_name = event.get('language')

    # Deduplicated results dictionaries
    priority_result = {}
    suggestions_result = {}
    document_list = []

    # 1. Try Mangools Integration
    try:
        google_location_ids = {
            "Afghanistan": 2004, "Albania": 2008, "Algeria": 2012, "American Samoa": 2016, "Andorra": 2020,
            "Angola": 2024, "Anguilla": 2028, "Antarctica": 2032, "Antigua and Barbuda": 2036, "Argentina": 2040,
            "Armenia": 2044, "Aruba": 2048, "Australia": 2052, "Austria": 2056, "Azerbaijan": 2060, "Bahamas": 2064,
            "Bahrain": 2068, "Bangladesh": 2072, "Barbados": 2076, "Belarus": 2080, "Belgium": 2084, "Belize": 2088,
            "Benin": 2092, "Bermuda": 2096, "Bhutan": 2100, "Bolivia": 2104, "Bosnia and Herzegovina": 2108,
            "Botswana": 2112, "Bouvet Island": 2116, "Brazil": 2120, "British Indian Ocean Territory": 2124,
            "Brunei Darussalam": 2128, "Bulgaria": 2132, "Burkina Faso": 2136, "Burundi": 2140, "Cambodia": 2144,
            "Cameroon": 2148, "Canada": 2152, "Cape Verde": 2156, "Cayman Islands": 2160, "Central African Republic": 2164,
            "Chad": 2168, "Chile": 2172, "China": 2176, "Christmas Island": 2180, "Cocos (Keeling) Islands": 2184,
            "Colombia": 2188, "Comoros": 2192, "Congo": 2196, "Congo, the Democratic Republic of the": 2200,
            "Cook Islands": 2204, "Costa Rica": 2208, "Côte d'Ivoire": 2212, "Croatia": 2216, "Cuba": 2220,
            "Cyprus": 2224, "Czech Republic": 2228, "Denmark": 2232, "Djibouti": 2236, "Dominica": 2240,
            "Dominican Republic": 2244, "Ecuador": 2248, "Egypt": 2252, "El Salvador": 2256, "Equatorial Guinea": 2260,
            "Eritrea": 2264, "Estonia": 2268, "Ethiopia": 2272, "Falkland Islands (Malvinas)": 2276, "Faroe Islands": 2280,
            "Fiji": 2284, "Finland": 2288, "France": 2292, "French Guiana": 2296, "French Polynesia": 2300,
            "French Southern Territories": 2304, "Gabon": 2308, "Gambia": 2312, "Georgia": 2316, "Germany": 2320,
            "Ghana": 2324, "Gibraltar": 2328, "Greece": 2332, "Greenland": 2336, "Grenada": 2340, "Guadeloupe": 2344,
            "Guam": 2348, "Guatemala": 2352, "Guernsey": 2356, "Guinea": 2360, "Guinea-Bissau": 2364, "Guyana": 2368,
            "Haiti": 2372, "Heard Island and McDonald Islands": 2376, "Holy See (Vatican City State)": 2380,
            "Honduras": 2384, "Hong Kong": 2388, "Hungary": 2392, "Iceland": 2396, "India": 2400, "Indonesia": 2404,
            "Iran, Islamic Republic of": 2408, "Iraq": 2412, "Ireland": 2416, "Isle of Man": 2420, "Israel": 2424,
            "Italy": 2428, "Jamaica": 2432, "Japan": 2436, "Jersey": 2440, "Jordan": 2444, "Kazakhstan": 2448,
            "Kenya": 2452, "Kiribati": 2456, "Korea, Democratic People's Republic of": 2460, "Korea, Republic of": 2464,
            "Kuwait": 2468, "Kyrgyzstan": 2472, "Lao People's Democratic Republic": 2476, "Latvia": 2480, "Lebanon": 2484,
            "Lesotho": 2488, "Liberia": 2492, "Libyan Arab Jamahiriya": 2496, "Liechtenstein": 2500, "Lithuania": 2504,
            "Luxembourg": 2508, "Macao": 2512, "Macedonia, the former Yugoslav Republic of": 2516, "Madagascar": 2520,
            "Malawi": 2524, "Malaysia": 2528, "Maldives": 2532, "Mali": 2536, "Malta": 2540, "Marshall Islands": 2544,
            "Martinique": 2548, "Mauritania": 2552, "Mauritius": 2556, "Mayotte": 2560, "Mexico": 2564,
            "Micronesia, Federated States of": 2568, "Moldova, Republic of": 2572, "Monaco": 2576, "Mongolia": 2580,
            "Montenegro": 2584, "Montserrat": 2588, "Morocco": 2592, "Mozambique": 2596, "Myanmar": 2600, "Namibia": 2604,
            "Nauru": 2608, "Nepal": 2612, "Netherlands": 2616, "Netherlands Antilles": 2620, "New Caledonia": 2624,
            "New Zealand": 2628, "Nicaragua": 2632, "Niger": 2636, "Nigeria": 2640, "Niue": 2644, "Norfolk Island": 2648,
            "Northern Mariana Islands": 2652, "Norway": 2656, "Oman": 2660, "Pakistan": 2664, "Palau": 2668,
            "Palestinian Territory, Occupied": 2672, "Panama": 2676, "Papua New Guinea": 2680, "Paraguay": 2684,
            "Peru": 2688, "Philippines": 2692, "Pitcairn": 2696, "Poland": 2700, "Portugal": 2701, "Singapore": 2702,
            "Puerto Rico": 2703, "Qatar": 2704, "Réunion": 2708, "Romania": 2712, "Russian Federation": 2716,
            "Rwanda": 2720, "Saint Helena": 2724, "Saint Kitts and Nevis": 2728, "Saint Lucia": 2732,
            "Saint Pierre and Miquelon": 2736, "Saint Vincent and the Grenadines": 2740, "Samoa": 2744, "San Marino": 2748,
            "Sao Tome and Principe": 2752, "Saudi Arabia": 2756, "Senegal": 2760, "Serbia": 2764, "Seychelles": 2768,
            "Sierra Leone": 2772, "Slovakia": 2776, "Slovenia": 2780, "Solomon Islands": 2784, "Somalia": 2788,
            "South Africa": 2792, "South Georgia and the South Sandwich Islands": 2796, "Spain": 2800, "Sri Lanka": 2804,
            "Sudan": 2808, "Suriname": 2812, "Svalbard and Jan Mayen": 2816, "Swaziland": 2820, "Sweden": 2824,
            "Switzerland": 2828, "Syrian Arab Republic": 2832, "Taiwan, Province of China": 2836, "Tajikistan": 2840,
            "Tanzania, United Republic of": 2844, "Thailand": 2848, "Timor-Leste": 2852, "Togo": 2856, "Tokelau": 2860,
            "Tonga": 2864, "Trinidad and Tobago": 2868, "Tunisia": 2872, "Turkey": 2876, "Turkmenistan": 2880,
            "Turks and Caicos Islands": 2884, "Tuvalu": 2888, "Uganda": 2892, "Ukraine": 2896, "United Arab Emirates": 2900,
            "United Kingdom": 2904, "United States": 2908, "United States Minor Outlying Islands": 2912, "Uruguay": 2916,
            "Uzbekistan": 2920, "Vanuatu": 2924, "Venezuela": 2928, "Viet Nam": 2932, "Virgin Islands, British": 2936,
            "Virgin Islands, U.S.": 2940, "Wallis and Futuna": 2944, "Western Sahara": 2948, "Yemen": 2952,
            "Zambia": 2956, "Zimbabwe": 2960
        }

        language_ids = {
            'Arabic': 1019, 'Bengali': 1056, 'Bulgarian': 1020, 'Catalan': 1038, 'Chinese (simplified)': 1017,
            'Chinese (traditional)': 1018, 'Croatian': 1039, 'Czech': 1021, 'Danish': 1009, 'Dutch': 1010,
            'English': 1000, 'Estonian': 1043, 'Filipino': 1042, 'Finnish': 1011, 'French': 1002, 'German': 1001,
            'Greek': 1022, 'Gujarati': 1072, 'Hebrew': 1027, 'Hindi': 1023, 'Hungarian': 1024, 'Icelandic': 1026,
            'Indonesian': 1025, 'Italian': 1004, 'Japanese': 1005, 'Kannada': 1086, 'Korean': 1012, 'Latvian': 1028,
            'Lithuanian': 1029, 'Malay': 1102, 'Malayalam': 1098, 'Marathi': 1101, 'Norwegian': 1013, 'Persian': 1064,
            'Polish': 1030, 'Portuguese': 1014, 'Punjabi': 1110, 'Romanian': 1032, 'Russian': 1031, 'Serbian': 1035,
            'Slovak': 1033, 'Slovenian': 1034, 'Spanish': 1003, 'Swedish': 1015, 'Tamil': 1130, 'Telugu': 1131,
            'Thai': 1044, 'Turkish': 1037, 'Ukrainian': 1036, 'Urdu': 1041, 'Vietnamese': 1040
        }

        mangools_success = False
        headers = {
            'X-access-Token': "8fb40ae3e00fefeac51878d30ed77e2302e8da4acdfe3ff96600de6b14c73328",
            'Content-Type': 'application/json'
        }

        for kw in keywords_input:
            try:
                api_url = f'https://api.mangools.com/v3/kwfinder/related-keywords?kw={kw}&location_id={google_location_ids[location]}&language_id={language_ids[language_name]}'
                response = requests.get(api_url, headers=headers)
                if response.status_code == 200:
                    mangools_success = True
                    kw_data = response.json()
                    if 'keywords' in kw_data:
                        for suggestion in kw_data['keywords']:
                            kw_name = suggestion['kw']
                            
                            # Competition text logic
                            seo = suggestion['seo']
                            if 0 <= seo <= 14: text = "easy"
                            elif 15 <= seo <= 29: text = "still easy"
                            elif 30 <= seo <= 49: text = "possible"
                            elif 50 <= seo <= 69: text = "hard"
                            elif 70 <= seo <= 84: text = "very hard"
                            else: text = "don't do it"

                            data_obj = {
                                'search_volume': suggestion['sv'],
                                'cpc': suggestion.get('cpc'),
                                'competition': suggestion['seo'],
                                'competition_text': text
                            }

                            # PRIORITIZATION: If it's one of the input keywords, put in priority_result
                            if kw_name.lower() in [k.lower() for k in keywords_input]:
                                # Keep original casing if possible, or use current
                                priority_result[kw_name] = data_obj
                            elif kw_name not in priority_result and kw_name not in suggestions_result:
                                suggestions_result[kw_name] = data_obj
                                
            except Exception as e:
                print(f"Error fetching from Mangools for keyword '{kw}': {e}")

        if mangools_success:
            # Merge results: priority first
            final_result = {**priority_result, **suggestions_result}
            
            # Prepare and insert into MongoDB
            for kw, data in final_result.items():
                document_list.append({
                    "keyword": kw,
                    "search_vol": data['search_volume'],
                    "cpc": data['cpc'],
                    "date": local_datetime,
                    "location": location,
                    "competition": data['competition'],
                    "competition_text": data.get('competition_text'),
                    "user": user
                })
            if document_list:
                collection.insert_many(document_list)
            
            return {'statusCode': 200, 'body': final_result}

    except Exception as e:
        print("Mangools attempt failed, falling back to DataForSEO:", e)

    # 2. DataForSEO Fallback
    print("Using DataForSEO fallback")
    language_dict = {
        'Arabic': 'ar', 'Bengali': 'bn', 'Bulgarian': 'bg', 'Catalan': 'ca', 'Chinese (Simplified)': 'zh_CN',
        'Chinese (Traditional)': 'zh_TW', 'Croatian': 'hr', 'Czech': 'cs', 'Danish': 'da', 'Dutch': 'nl',
        'English': 'en', 'Estonian': 'et', 'Farsi': 'fa', 'Finnish': 'fi', 'French': 'fr', 'German': 'de',
        'Greek': 'el', 'Hebrew (old)': 'iw', 'Hindi': 'hi', 'Hungarian': 'hu', 'Icelandic': 'is',
        'Indonesian': 'id', 'Italian': 'it', 'Japanese': 'ja', 'Korean': 'ko', 'Latvian': 'lv',
        'Lithuanian': 'lt', 'Malay': 'ms', 'Norwegian': 'no', 'Polish': 'pl', 'Portuguese': 'pt',
        'Romanian': 'ro', 'Russian': 'ru', 'Serbian': 'sr', 'Slovak': 'sk', 'Slovenian': 'sl',
        'Spanish': 'es', 'Swedish': 'sv', 'Tagalog': 'tl', 'Tamil': 'ta', 'Telugu': 'te', 'Thai': 'th',
        'Turkish': 'tr', 'Ukrainian': 'uk', 'Urdu': 'ur', 'Vietnamese': 'vi'
    }

    try:
        lang_code = language_dict.get(language_name, 'en')
        apikey = os.environ.get("API_KEY")
        api_url = "https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live"

        # DataForSEO supports multiple keywords in one call
        payload = [{
            "keywords": keywords_input,
            "location_name": location,
            "language_code": lang_code,
            "sort_by": "relevance"
        }]

        headers = {
            'Authorization': apikey,
            'Content-Type': 'application/json'
        }

        response = requests.post(api_url, headers=headers, json=payload)
        resp_json = response.json()
        
        if 'tasks' in resp_json and resp_json['tasks'][0]['result']:
            for suggestion in resp_json['tasks'][0]['result']:
                kw_name = suggestion['keyword']
                data_obj = {
                    'competition': suggestion.get('competition'),
                    'search_volume': suggestion.get("search_volume"),
                    'cpc': suggestion.get("cpc")
                }
                
                # PRIORITIZATION
                if kw_name.lower() in [k.lower() for k in keywords_input]:
                    priority_result[kw_name] = data_obj
                elif kw_name not in priority_result and kw_name not in suggestions_result:
                    suggestions_result[kw_name] = data_obj

        # If still short on results, try to expand with GPT
        if (len(priority_result) + len(suggestions_result)) < 20:
            print("Expanding with GPT...")
            gpt_url = "https://api.openai.com/v1/chat/completions"
            prompt = f"You are an SEO expert doing keyword research. Output as a list (only) in the format: [keyword1,keyword2,keyword3]. Come up with 20 similar keywords from the root keyword(s): {json.dumps(keywords_input)}"
            
            gpt_payload = {
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}]
            }
            gpt_headers = {
                "Content-Type": "application/json",
                'Authorization': f"Bearer {os.environ.get('OPENAI_API_KEY')}"
            }
            
            gpt_resp = requests.post(gpt_url, headers=gpt_headers, json=gpt_payload)
            gpt_text = gpt_resp.json()['choices'][0]['message']['content']
            gpt_kw_list = gpt_text.replace('[','').replace(']','').split(',')
            gpt_kw_list = [k.strip() for k in gpt_kw_list if k.strip()]

            if gpt_kw_list:
                payload[0]['keywords'] = gpt_kw_list
                response = requests.post(api_url, headers=headers, json=payload)
                resp_json = response.json()
                if 'tasks' in resp_json and resp_json['tasks'][0]['result']:
                    for suggestion in resp_json['tasks'][0]['result']:
                        kw_name = suggestion['keyword']
                        data_obj = {
                            'competition': suggestion.get('competition'),
                            'search_volume': suggestion.get("search_volume"),
                            'cpc': suggestion.get("cpc")
                        }
                        if kw_name not in priority_result and kw_name not in suggestions_result:
                            suggestions_result[kw_name] = data_obj

        final_result = {**priority_result, **suggestions_result}
        
        for kw, data in final_result.items():
            document_list.append({
                "keyword": kw,
                "search_vol": data.get('search_volume'),
                "cpc": data.get("cpc"),
                "date": local_datetime,
                "location": location,
                "competition": data.get('competition'),
                "competition_index": data.get('competition_index'),
                "user": user
            })

        if document_list:
            collection.insert_many(document_list)

        return {
            'statusCode': 200,
            'body': final_result
        }

    except Exception as e:
        print("Final error in Lambda:", e)
        return {
            'statusCode': 500,
            'body': {'error': str(e)}
        }
