#!pip install slack_sdk

import requests
import pandas as pd
from datetime import date, datetime, timedelta
import datetime
import re
import math
import time
import json
import datetime
import pytz
import os

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from oauth2client.service_account import ServiceAccountCredentials
import gspread

pd.options.display.max_colwidth = 500
pd.set_option('display.max_rows', None)

try:
    timezone = pytz.timezone("Singapore")
    today_date = date.today()

    monday_api_key = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjE2MTMyMzY2NywidWlkIjoyNzA4NzA3NywiaWFkIjoiMjAyMi0wNS0xOVQwNzo0Mjo1NS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NDk4MzM0NiwicmduIjoidXNlMSJ9.9-t-toyfO0RkHNHzBpHOfUwmJcfBKEaBCucIRAn6U_8"

    apiUrl = "https://api.monday.com/v2"
    headers = {"Authorization" : monday_api_key,
               'API-Version' : '2023-10'}

    #list all boards

    query2 = '{ folders (limit:100) {name id} }'
    data = {'query' : query2}

    r = requests.post(url=apiUrl, json=data, headers=headers)
    board_data = r.json()
    df_folder = pd.DataFrame(board_data['data']['folders'])
    df_folder.rename(columns={"id": "board_folder_id","name":"folder_name"},inplace=True)

    #list all boards

    query2 = '{ boards (limit:1000) {board_folder_id name id description} }'
    data = {'query' : query2}

    r = requests.post(url=apiUrl, json=data, headers=headers)
    board_data = r.json()
    df = pd.DataFrame.from_dict(board_data['data']['boards'])

    #to get the folder names
    df = df.merge(df_folder,on="board_folder_id", how="left")
    
    MAX_RETRIES = 5
    RETRY_WAIT_SECS = 10

    def post_with_retry(url, json, headers, max_retries=MAX_RETRIES, wait_secs=RETRY_WAIT_SECS, timeout=60):
        """POST with retries; wait only after failures."""
        attempt = 0
        last_err = None
        while attempt < max_retries:
            try:
                r = requests.post(url=url, json=json, headers=headers, timeout=timeout)
                # Consider non-2xx as failure
                if 200 <= r.status_code < 300:
                    return r
                last_err = f"HTTP {r.status_code}: {r.text[:300]}"
            except Exception as e:
                last_err = str(e)
            attempt += 1
            if attempt < max_retries:
                time.sleep(wait_secs)  # wait ONLY on failure
        raise RuntimeError(f"POST failed after {max_retries} attempts. Last error: {last_err}")

    # campaigns in PSG Grant or NON-PSG Timelines
    df_all = pd.DataFrame()
    counter = 1

    folders = ['PSG V3 Campaigns','9. PSG Campaigns','9. Regular Campaigns',
               '9. After-PSG Campaigns','Regular Campaign in Old Board','SaaS Campaign']

    for index, row in df[df['folder_name'].isin(folders)].iterrows():
        df_temporary = pd.DataFrame()
        query2 = (
            '{boards  (ids:' + row['id'] + ') {'
            'items_page (limit:500) {'
            'cursor items {id name relative_link updated_at '
            'column_values{ column{ id title } text}'
            'subitems {id name relative_link updated_at column_values{ column {id title} text}}'
            '} } } }'
        )
        data = {'query': query2}

        try:
            r = post_with_retry(url=apiUrl, json=data, headers=headers)
            temp = r.json()

            # Defensive: ensure the expected keys exist
            boards = temp.get('data', {}).get('boards', [])
            if not boards or not boards[0].get('items_page') or not boards[0]['items_page'].get('items'):
                # Nothing to add for this board
                print(f"Skipped board id={row['id']}: no items found")
            else:
                for main_item in boards[0]['items_page']['items']:
                    try:
                        # map indices for main item
                        status_index = assigned_index = timeline_index = None
                        for i in main_item['column_values']:
                            t = i['column']['title']
                            if t == 'Status':
                                status_index = main_item['column_values'].index(i)
                            elif t == 'Assigned Person':
                                assigned_index = main_item['column_values'].index(i)
                            elif t in ('Timeline', 'Timeline (Estimated)'):
                                timeline_index = main_item['column_values'].index(i)

                        df_temporary = pd.concat([
                            df_temporary,
                            pd.DataFrame([{
                                'name': row['name'],
                                'board_id': row['id'],
                                'item': main_item['name'],
                                'status': main_item['column_values'][status_index]['text'] if status_index is not None else '',
                                'assigned': main_item['column_values'][assigned_index]['text'] if assigned_index is not None else '',
                                'timeline': main_item['column_values'][timeline_index]['text'] if timeline_index is not None else '',
                                'link': 'https://mediaone-business-group-pte-ltd.monday.com' + main_item['relative_link'],
                                'last_updated': main_item['updated_at'].split('T')[0] if 'updated_at' in main_item else ''
                            }])
                        ], ignore_index=True)

                        # subitems
                        if 'subitems' in main_item and main_item['subitems']:
                            for j in main_item['subitems']:
                                status_index = assigned_index = timeline_index = None
                                for k in j['column_values']:
                                    t = k['column']['title']
                                    if t in ('Status', 'Content Status'):
                                        status_index = j['column_values'].index(k)
                                    elif t == 'POC':
                                        assigned_index = j['column_values'].index(k)
                                    elif t == 'Due Date':
                                        timeline_index = j['column_values'].index(k)

                                df_temporary = pd.concat([
                                    df_temporary,
                                    pd.DataFrame([{
                                        'name': row['name'],
                                        'board_id': row['id'],
                                        'item': f"{main_item['name']}: {j['name']}",
                                        'status': j['column_values'][status_index]['text'] if status_index is not None else '',
                                        'assigned': j['column_values'][assigned_index]['text'] if assigned_index is not None else '',
                                        'timeline': j['column_values'][timeline_index]['text'] if timeline_index is not None else '',
                                        'link': 'https://mediaone-business-group-pte-ltd.monday.com' + j['relative_link']
                                    }])
                                ], ignore_index=True)

                    except IndexError:
                        # keep behaviour consistent with original code
                        continue

        except Exception as e:
            # Could not fetch this board even after retries; skip it and continue
            print(f"Error fetching board id={row['id']}: {e}")
            # No wait here; we already waited inside the retry helper

        df_all = pd.concat([df_all, df_temporary], ignore_index=True)
        print(
            f"{counter}/" +
            str(len(df[df['folder_name'].isin(folders)])),
            end='\r'
        )
        counter += 1
        # Removed unconditional sleep(7); waiting only happens on failed calls

    df_all.fillna('', inplace=True)

    # Safe split helpers (avoid errors when 'timeline' is empty or malformed)
    def parse_deadline(t):
        if not isinstance(t, str) or '-' not in t:
            return ''
        parts = t.split('-')
        return '-'.join(parts[3:]).lstrip() if len(parts) > 3 else ''

    def parse_start_date(t):
        if not isinstance(t, str) or '-' not in t:
            return ''
        parts = t.split('-')
        return '-'.join(parts[:3]).lstrip() if len(parts) >= 3 else ''

    df_all['deadline'] = df_all['timeline'].apply(parse_deadline)
    df_all['start_date'] = df_all['timeline'].apply(parse_start_date)

    df_all = df_all[~df_all['name'].str.contains("Template|Test")]

    # clean up staff names ' '

    for index, row in df_all.iterrows():
        try:
            names = row['assigned'].strip().split(',')
            try:
                df_all.at[index,'assigned'] = names.remove(' ')
            except ValueError:
                continue
        except AttributeError:
            continue

        df_all.at[index,'assigned'] = ",".join(names)    

    scope = ['https://spreadsheets.google.com/feeds','https://www.googleapis.com/auth/drive']

    # add credentials to the account
    creds = ServiceAccountCredentials.from_json_keyfile_name('bubbly.json', scope)

    # authorize the clientsheet 
    client = gspread.authorize(creds)

    worksheet = client.open('Individual Timeliness Report').worksheet("Boards Combined")

    worksheet.batch_clear(["A2:J99999"])

    # headers
    #worksheet.update('A1:ZZ1',[list(df_all.columns.values)])

    #data
    worksheet.update('A2:J99999',df_all.values.tolist())

    query2 = '{boards (ids:2845615047){items_page (limit:400){items { group {title id} id name column_values{ column{ id title } text value}subitems { column_values{text value}}}}}}'
    data = {'query' : query2}

    r = requests.post(url=apiUrl, json=data, headers=headers)
    board_data = r.json()

    group_dict = {}

    for i in board_data['data']['boards'][0]['items_page']['items']:
        group_dict.update({i['group']['title']:i['group']['id']})

    column_ids = {}
    for i in board_data['data']['boards'][0]['items_page']['items'][0]['column_values']:
        column_ids.update({i['column']['title']:i['column']['id']})

    dictionary = {}
    count = 0

    for i in board_data['data']['boards'][0]['items_page']['items'][0]['column_values']:
        dictionary.update({i['column']['title']:count})
        count+=1

    df_integrated_current = pd.DataFrame()
    count = 0

    for campaign in board_data['data']['boards'][0]['items_page']['items']:
        df_integrated_current.at[count,'client'] = campaign['name']
        df_integrated_current.at[count,'id'] = campaign['id']
        df_integrated_current.at[count,'group_id'] = campaign['group']['id']
        for key,value in dictionary.items():
            df_integrated_current.at[count,key] = campaign['column_values'][dictionary[key]]['text']

        count+=1
        
    scope = ['https://spreadsheets.google.com/feeds','https://www.googleapis.com/auth/drive']

    # add credentials to the account
    creds = ServiceAccountCredentials.from_json_keyfile_name('bubbly.json', scope)

    # authorize the clientsheet 
    client = gspread.authorize(creds)

    worksheet = client.open('Individual Timeliness Report').worksheet("Boards Combined")

    worksheet.batch_clear(["A2:J99999"])

    # headers
    #worksheet.update('A1:ZZ1',[list(df_all.columns.values)])

    #data
    worksheet.update('A2:J99999',df_all.values.tolist())
    
    df_integrated_current = df_integrated_current[(~df_integrated_current['[CSM] Campaign Status'].str.contains('Expired'))&(~df_integrated_current['client'].str.contains('TEMPLATE'))]

    for index, row in df_integrated_current.iterrows():
        for header in ['Project Manager','Asst PM','SEM','Sales','SEO','Asst SEO','Content / Social / Design']:
            try:
                staff_names = df_integrated_current.at[index,header].split(',')
            except:
                continue
            try:
                df_integrated_current.at[index, header] = staff_names.remove('')
            except ValueError:
                continue

    #post to google sheets

    scope = ['https://spreadsheets.google.com/feeds','https://www.googleapis.com/auth/drive']

    # add credentials to the account
    creds = ServiceAccountCredentials.from_json_keyfile_name('bubbly.json', scope)

    # authorize the clientsheet 
    client = gspread.authorize(creds)

    worksheet = client.open('Individual Timeliness Report').worksheet("Integrated Board")

    worksheet.clear()

    #data 
    worksheet.update('A2:ZZ99999',df_integrated_current.fillna('').values.tolist())

    #headers
    worksheet.update('A1:ZZ1',[list(df_integrated_current.columns.values)])


except:
    # Path to your service account key file
    service_account_file = "bubbly.json" 

    # Your Google Chat Space ID (e.g., "spaces/AAAABBBBCCCCDDD")
    space_id = "spaces/AAAAJL1Hcb4"
    
    # Define the message content
    message = {
        "text": "Updating of Individual Timeliness Report did not run succesfully"
    }

    # Authenticate with Google Chat API
    credentials = service_account.Credentials.from_service_account_file(
        service_account_file, scopes=["https://www.googleapis.com/auth/chat.bot"])

    service = build('chat', 'v1', credentials=credentials)

    # Send the message to the Google Chat space
    response = service.spaces().messages().create(
        parent=space_id, body=message).execute()