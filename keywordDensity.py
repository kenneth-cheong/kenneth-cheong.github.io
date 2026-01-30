import json
import requests
import time
import os

def lambda_handler(event, context):
    target = event['target']
    #post
    url = "https://api.dataforseo.com/v3/on_page/task_post"

    apiKey = os.environ.get("API_KEY")

    payload=[{"target":target,
            "max_crawl_pages":1,
            "enable_javascript":True,
            "validate_micromarkup":True,
            "calculate_keyword_density":True}]

    headers = {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
    }

    response = requests.request("POST", url, headers=headers, json=payload)

    task_id = response.json()['tasks'][0]['id']

    url = "https://api.dataforseo.com/v3/on_page/keyword_density"

    # Define keyword lengths to analyze
    keyword_lengths = [2, 3, 4, 5]

    # Prepare the payload for each keyword length
    payload = []
    for length in keyword_lengths:
        payload.append({
            "id": task_id,
            "keyword_length": length,
            "limit": 1000,  # Adjust limit as needed
            "order_by": ["frequency,desc"],  # Sort by frequency descending
            "filters": [["frequency",">","1"]]
        })

    # API headers (replace with your actual credentials)
    headers = {
        'Authorization': 'Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM=',
        'Content-Type': 'application/json'
    }

    time.sleep(6)

    # Send the API requests and process the responses
    all_results = {}
    for p in payload:
        response = requests.request("POST", url, headers=headers, json=[p])
        data = response.json()
        print(data)

        while data['tasks'][0]['status_message'] == "Task in Queue." or data['tasks'][0]['result'][0]['crawl_progress'] == "in_progress":
            response = requests.request("POST", url, headers=headers, json=[p]) 
            data = response.json()

        print(data)
        # Check for errors in the response
        if 'tasks' in data and data['tasks']:  # Check if 'tasks' exist and is not empty
            try: # use try block for error handling in case the result you're searching for do not exist
                print(json.dumps(data['tasks'][0]['result'][:150]))
                print()
                results = data['tasks'][0]['result'][0]['items']  # Extract the relevant data

                # Add keyword length information to each result
                for item in results:
                    item['keyword_length'] = p['keyword_length']  # Add the keyword length

                # Store results in the dictionary, keyed by keyword length
                all_results[p['keyword_length']] = results
            except KeyError as e:
                print(f"KeyError: {e} in response for keyword_length {p['keyword_length']}. Check the response structure.")
                #print(data)  # Print the full response for debugging
            except IndexError as e:
                print(f"IndexError: {e} in response for keyword_length {p['keyword_length']}. Check the response structure.")
                #print(data)  # Print the full response for debugging
            except TypeError as e:
                print("TypeError", e)
                continue
        else:
            print(f"Error: No tasks found in response for keyword_length {p['keyword_length']}")
            #print(data) # Print the full response for debugging

    # Flatten the dictionary into a single list and sort by frequency
    if all_results:
        combined_results = []
        for keyword_length, results in all_results.items():
            combined_results.extend(results)

        combined_results = sorted(combined_results, key=lambda x: x.get('frequency', 0), reverse=True)

    else:
        print("No results found. Check your API credentials, ID, and payload.")
        combined_results = None
        
    return (combined_results)
