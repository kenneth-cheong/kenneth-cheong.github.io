import json
import requests
import os
from pymongo.mongo_client import MongoClient
from pymongo.server_api import ServerApi
from datetime import datetime
from pytz import timezone

def difficulty_band(kd):
    """Keyword difficulty (0-100) -> the Mangools wording our UIs already use.
    Both providers score on the same scale, so they share one band table."""
    try:
        kd = float(kd)
    except (TypeError, ValueError):
        return None
    if kd <= 14:
        return "easy"
    if kd <= 29:
        return "still easy"
    if kd <= 49:
        return "possible"
    if kd <= 69:
        return "hard"
    if kd <= 84:
        return "very hard"
    return "don't do it"


def fetch_keyword_difficulty(keywords, location, language):
    """Real SEO keyword difficulty (0-100) from DataForSEO Labs.
    Returns {keyword: difficulty}; keywords Labs has no score for are omitted."""
    res = requests.request(
        "POST",
        "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live",
        headers={
            'Authorization': os.environ.get("API_KEY"),
            'Content-Type': 'application/json',
        },
        json=[{"keywords": keywords,
               "location_name": location,
               "language_name": language}],
        timeout=55,
    )
    data = res.json()
    tasks = data.get('tasks') or []
    result = (tasks[0].get('result') if tasks else None) or []
    items = (result[0].get('items') if result else None) or []
    return {i['keyword']: i['keyword_difficulty']
            for i in items
            if i.get('keyword') and i.get('keyword_difficulty') is not None}


def lambda_handler(event, context):
    keywords = event["keywords"]
    language = event['language']
    location = event['location']
    if location == "None":
        location = None
    try:
        user = event['user']
    except:
        pass

    '''
    pacific = timezone("Asia/Singapore")
    local_datetime = pacific.localize(datetime.today())

    uri = os.environ.get('MONGO_URI', '')
    client = MongoClient(uri)
    database = client["webpage"]
    collection = database["ranking_keywords"]

    document_list = []
    '''

    google_location_ids = {
    "Afghanistan": 2004,
    "Albania": 2008,
    "Algeria": 2012,
    "American Samoa": 2016,
    "Andorra": 2020,
    "Angola": 2024,
    "Anguilla": 2028,
    "Antarctica": 2032,
    "Antigua and Barbuda": 2036,
    "Argentina": 2040,
    "Armenia": 2044,
    "Aruba": 2048,
    "Australia": 2052,
    "Austria": 2056,
    "Azerbaijan": 2060,
    "Bahamas": 2064,
    "Bahrain": 2068,
    "Bangladesh": 2072,
    "Barbados": 2076,
    "Belarus": 2080,
    "Belgium": 2084,
    "Belize": 2088,
    "Benin": 2092,
    "Bermuda": 2096,
    "Bhutan": 2100,
    "Bolivia": 2104,
    "Bosnia and Herzegovina": 2108,
    "Botswana": 2112,
    "Bouvet Island": 2116,
    "Brazil": 2120,
    "British Indian Ocean Territory": 2124,
    "Brunei Darussalam": 2128,
    "Bulgaria": 2132,
    "Burkina Faso": 2136,
    "Burundi": 2140,
    "Cambodia": 2144,
    "Cameroon": 2148,
    "Canada": 2152,
    "Cape Verde": 2156,
    "Cayman Islands": 2160,
    "Central African Republic": 2164,
    "Chad": 2168,
    "Chile": 2172,
    "China": 2176,
    "Christmas Island": 2180,
    "Cocos (Keeling) Islands": 2184,
    "Colombia": 2188,
    "Comoros": 2192,
    "Congo": 2196,
    "Congo, the Democratic Republic of the": 2200,
    "Cook Islands": 2204,
    "Costa Rica": 2208,
    "Côte d'Ivoire": 2212,
    "Croatia": 2216,
    "Cuba": 2220,
    "Cyprus": 2224,
    "Czech Republic": 2228,
    "Denmark": 2232,
    "Djibouti": 2236,
    "Dominica": 2240,
    "Dominican Republic": 2244,
    "Ecuador": 2248,
    "Egypt": 2252,
    "El Salvador": 2256,
    "Equatorial Guinea": 2260,
    "Eritrea": 2264,
    "Estonia": 2268,
    "Ethiopia": 2272,
    "Falkland Islands (Malvinas)": 2276,
    "Faroe Islands": 2280,
    "Fiji": 2284,
    "Finland": 2288,
    "France": 2292,
    "French Guiana": 2296,
    "French Polynesia": 2300,
    "French Southern Territories": 2304,
    "Gabon": 2308,
    "Gambia": 2312,
    "Georgia": 2316,
    "Germany": 2320,
    "Ghana": 2324,
    "Gibraltar": 2328,
    "Greece": 2332,
    "Greenland": 2336,
    "Grenada": 2340,
    "Guadeloupe": 2344,
    "Guam": 2348,
    "Guatemala": 2352,
    "Guernsey": 2356,
    "Guinea": 2360,
    "Guinea-Bissau": 2364,
    "Guyana": 2368,
    "Haiti": 2372,
    "Heard Island and McDonald Islands": 2376,
    "Holy See (Vatican City State)": 2380,
    "Honduras": 2384,
    "Hong Kong": 2388,
    "Hungary": 2392,
    "Iceland": 2396,
    "India": 2400,
    "Indonesia": 2404,
    "Iran, Islamic Republic of": 2408,
    "Iraq": 2412,
    "Ireland": 2416,
    "Isle of Man": 2420,
    "Israel": 2424,
    "Italy": 2428,
    "Jamaica": 2432,
    "Japan": 2436,
    "Jersey": 2440,
    "Jordan": 2444,
    "Kazakhstan": 2448,
    "Kenya": 2452,
    "Kiribati": 2456,
    "Korea, Democratic People's Republic of": 2460,
    "Korea, Republic of": 2464,
    "Kuwait": 2468,
    "Kyrgyzstan": 2472,
    "Lao People's Democratic Republic": 2476,
    "Latvia": 2480,
    "Lebanon": 2484,
    "Lesotho": 2488,
    "Liberia": 2492,
    "Libyan Arab Jamahiriya": 2496,
    "Liechtenstein": 2500,
    "Lithuania": 2504,
    "Luxembourg": 2508,
    "Macao": 2512,
    "Macedonia, the former Yugoslav Republic of": 2516,
    "Madagascar": 2520,
    "Malawi": 2524,
    "Malaysia": 2528,
    "Maldives": 2532,
    "Mali": 2536,
    "Malta": 2540,
    "Marshall Islands": 2544,
    "Martinique": 2548,
    "Mauritania": 2552,
    "Mauritius": 2556,
    "Mayotte": 2560,
    "Mexico": 2564,
    "Micronesia, Federated States of": 2568,
    "Moldova, Republic of": 2572,
    "Monaco": 2576,
    "Mongolia": 2580,
    "Montenegro": 2584,
    "Montserrat": 2588,
    "Morocco": 2592,
    "Mozambique": 2596,
    "Myanmar": 2600,
    "Namibia": 2604,
    "Nauru": 2608,
    "Nepal": 2612,
    "Netherlands": 2616,
    "Netherlands Antilles": 2620,
    "New Caledonia": 2624,
    "New Zealand": 2628,
    "Nicaragua": 2632,
    "Niger": 2636,
    "Nigeria": 2640,
    "Niue": 2644,
    "Norfolk Island": 2648,
    "Northern Mariana Islands": 2652,
    "Norway": 2656,
    "Oman": 2660,
    "Pakistan": 2664,
    "Palau": 2668,
    "Palestinian Territory, Occupied": 2672,
    "Panama": 2676,
    "Papua New Guinea": 2680,
    "Paraguay": 2684,
    "Peru": 2688,
    "Philippines": 2692,
    "Pitcairn": 2696,
    "Poland": 2700,
    "Portugal": 2701,
    "Singapore": 2702,
    "Puerto Rico": 2703,
    "Qatar": 2704,
    "Réunion": 2708,
    "Romania": 2712,
    "Russian Federation": 2716,
    "Rwanda": 2720,
    "Saint Helena": 2724,
    "Saint Kitts and Nevis": 2728,
    "Saint Lucia": 2732,
    "Saint Pierre and Miquelon": 2736,
    "Saint Vincent and the Grenadines": 2740,
    "Samoa": 2744,
    "San Marino": 2748,
    "Sao Tome and Principe": 2752,
    "Saudi Arabia": 2756,
    "Senegal": 2760,
    "Serbia": 2764,
    "Seychelles": 2768,
    "Sierra Leone": 2772,
    "Slovakia": 2776,
    "Slovenia": 2780,
    "Solomon Islands": 2784,
    "Somalia": 2788,
    "South Africa": 2792,
    "South Georgia and the South Sandwich Islands": 2796,
    "Spain": 2800,
    "Sri Lanka": 2804,
    "Sudan": 2808,
    "Suriname": 2812,
    "Svalbard and Jan Mayen": 2816,
    "Swaziland": 2820,
    "Sweden": 2824,
    "Switzerland": 2828,
    "Syrian Arab Republic": 2832,
    "Taiwan, Province of China": 2836,
    "Tajikistan": 2840,
    "Tanzania, United Republic of": 2844,
    "Thailand": 2848,
    "Timor-Leste": 2852,
    "Togo": 2856,
    "Tokelau": 2860,
    "Tonga": 2864,
    "Trinidad and Tobago": 2868,
    "Tunisia": 2872,
    "Turkey": 2876,
    "Turkmenistan": 2880,
    "Turks and Caicos Islands": 2884,
    "Tuvalu": 2888,
    "Uganda": 2892,
    "Ukraine": 2896,
    "United Arab Emirates": 2900,
    "United Kingdom": 2904,
    "United States": 2908,
    "United States Minor Outlying Islands": 2912,
    "Uruguay": 2916,
    "Uzbekistan": 2920,
    "Vanuatu": 2924,
    "Venezuela": 2928,
    "Viet Nam": 2932,
    "Virgin Islands, British": 2936,
    "Virgin Islands, U.S.": 2940,
    "Wallis and Futuna": 2944,
    "Western Sahara": 2948,
    "Yemen": 2952,
    "Zambia": 2956,
    "Zimbabwe": 2960
    }


    language_ids = {
    'Arabic': 1019,
    'Bengali': 1056,
    'Bulgarian': 1020,
    'Catalan': 1038,
    'Chinese (simplified)': 1017,
    'Chinese (traditional)': 1018,
    'Croatian': 1039,
    'Czech': 1021,
    'Danish': 1009,
    'Dutch': 1010,
    'English': 1000,
    'Estonian': 1043,
    'Filipino': 1042,
    'Finnish': 1011,
    'French': 1002,
    'German': 1001,
    'Greek': 1022,
    'Gujarati': 1072,
    'Hebrew': 1027,
    'Hindi': 1023,
    'Hungarian': 1024,
    'Icelandic': 1026,
    'Indonesian': 1025,
    'Italian': 1004,
    'Japanese': 1005,
    'Kannada': 1086,
    'Korean': 1012,
    'Latvian': 1028,
    'Lithuanian': 1029,
    'Malay': 1102,
    'Malayalam': 1098,
    'Marathi': 1101,
    'Norwegian': 1013,
    'Persian': 1064,
    'Polish': 1030,
    'Portuguese': 1014,
    'Punjabi': 1110,
    'Romanian': 1032,
    'Russian': 1031,
    'Serbian': 1035,
    'Slovak': 1033,
    'Slovenian': 1034,
    'Spanish': 1003,
    'Swedish': 1015,
    'Tamil': 1130,
    'Telugu': 1131,
    'Thai': 1044,
    'Turkish': 1037,
    'Ukrainian': 1036,
    'Urdu': 1041,
    'Vietnamese': 1040
}

    try:
        api_url = "https://api.mangools.com/v3/kwfinder/keyword-imports"

        payload = {
            "keywords": keywords,
            "location_id": google_location_ids[location],
            "language_id": language_ids[language]
            }

        headers = {
            'X-access-Token': "8fb40ae3e00fefeac51878d30ed77e2302e8da4acdfe3ff96600de6b14c73328",
            'Content-Type': 'application/json'
        }

        response = requests.request("POST", api_url, headers=headers, json=payload, timeout=55)
        print(response.json())

        output = {}

        for keyword in response.json()['keywords']:
            output[keyword['kw']] = {}
            output[keyword['kw']]['search_volume'] = keyword['sv'] 
            output[keyword['kw']]['cpc'] = keyword['cpc'] 
            output[keyword['kw']]['ppc'] = keyword['ppc']
            output[keyword['kw']]['difficulty'] = keyword['seo']
            output[keyword['kw']]['difficulty_text'] = difficulty_band(keyword['seo'])
        print("used mangools")
    except Exception as e:
        # Log why Mangools was skipped — a bare `except` hid a dead Mangools
        # subscription for weeks, and the fallback silently dropped keyword
        # difficulty from every downstream tool (Time to Rank showed "—").
        print("mangools failed, falling back to dataforseo:", repr(e))

        apikey = os.environ.get("API_KEY")
        keywords = event['keywords']
        location = event['location']
        language = event['language']
        api_url = "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live"

        payload=[{"keywords":keywords,
                "location_name":location,
                "language_name":language}]

        headers = {
            'Authorization': apikey,
            'Content-Type': 'application/json'
        }

        response = requests.request("POST", api_url, headers=headers, json=payload, timeout=55)

        output = {}

        print(response.json())

        # DataForSEO returns result=None when it has no volume data for the
        # requested keyword/location/language combo. Treat that as "no rows"
        # instead of crashing (TypeError: 'NoneType' object is not iterable).
        data = response.json()
        tasks = data.get('tasks') or []
        result = (tasks[0].get('result') if tasks else None) or []
        for i in result:
            kw = i.get('keyword')
            if not kw:
                continue
            output[kw] = {}
            output[kw]['cpc'] = i.get('cpc')
            output[kw]['search_volume'] = i.get('search_volume')

        print("used dataforseo")

    # Neither volume source reliably carries SEO difficulty: the Ads endpoint has
    # no such field, and Mangools' `seo` comes back null whenever KWFinder hasn't
    # computed it for the import. Backfill from DataForSEO Labs, which scores on
    # the same 0-100 scale. Best-effort — volume/CPC must still return if this
    # call fails or the Labs plan lapses.
    missing = [kw for kw, m in output.items() if m.get('difficulty') is None]
    if missing:
        try:
            for kw, kd in fetch_keyword_difficulty(missing, location, language).items():
                # A keyword can have difficulty but no volume, so seed the row
                # rather than assuming the volume pass already created it.
                output.setdefault(kw, {})
                output[kw]['difficulty'] = kd
                output[kw]['difficulty_text'] = difficulty_band(kd)
            print("backfilled difficulty for", len(missing), "keywords")
        except Exception as kd_err:
            print("keyword difficulty backfill failed:", repr(kd_err))

    return {
        'statusCode': 200,
        'body': output
    }
