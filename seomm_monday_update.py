import requests
import pandas as pd
from datetime import date
import datetime
import logging
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import pytz
from datetime import datetime
from requests.exceptions import ConnectTimeout
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2 import service_account
import re
import time
import math

from oauth2client.service_account import ServiceAccountCredentials
import gspread

pd.options.display.max_colwidth = 500
pd.set_option('display.max_rows', None)

#get today's date in required api format
today_date = datetime.today().strftime('%Y-%m-%d')

monday_api_key = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjE2MTMyMzY2NywidWlkIjoyNzA4NzA3NywiaWFkIjoiMjAyMi0wNS0xOVQwNzo0Mjo1NS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NDk4MzM0NiwicmduIjoidXNlMSJ9.9-t-toyfO0RkHNHzBpHOfUwmJcfBKEaBCucIRAn6U_8"
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2025-04'}

#show Integrated Campaign Info Repository Board

combined_query = []

query2 = '{boards (ids:2845615047){items_page (limit:100){cursor items { group {title id} id name column_values{ column{ id title } text value}subitems { column_values{text value}}}}}}'
data = {'query' : query2}

r = requests.post(url=apiUrl, json=data, headers=headers)
board_data = r.json()
cursor = board_data['data']['boards'][0]['items_page']['cursor']
combined_query = board_data['data']['boards'][0]['items_page']['items']

for i in range(0,5):
    query2 = '{next_items_page (limit:100, cursor:"'+cursor+'") {cursor items { group {title id} id name column_values{ column{ id title } text value}subitems { column_values{text value}}}}}'
    data = {'query' : query2}

    r = requests.post(url=apiUrl, json=data, headers=headers)
    board_data = r.json()
    cursor = board_data['data']['next_items_page']['cursor']
    combined_query+=board_data['data']['next_items_page']['items']
    time.sleep(10)

dictionary = {}
count = 0

for i in combined_query[0]['column_values']:
    dictionary.update({i['column']['title']:count})
    count+=1

df_integrated_current = pd.DataFrame()
count = 0

for campaign in combined_query:
    df_integrated_current.at[count,'client'] = campaign['name']
    df_integrated_current.at[count,'id'] = campaign['id']
    df_integrated_current.at[count,'group_id'] = campaign['group']['id']
    for key,value in dictionary.items():
        df_integrated_current.at[count,key] = campaign['column_values'][dictionary[key]]['text']

    count+=1

for index, row in df_integrated_current.iterrows():
    list = row['client'].split()
    for word in list:
        if '//' in word or '.com' in word or 'www' in word:
            df_integrated_current.at[index,'domain'] = (word.replace('https://','').replace('www.','').replace('http://','')).split('/')[0]   
#df_integrated_current['domain'].mask(df_integrated_current['client']=="https://alliedtelesis-asia.com/ (India)", 'alliedtelesis-asia.com(india)', inplace=True)

df_integrated_current = df_integrated_current[(~df_integrated_current['SEO Campaign Status'].str.contains('Expired'))&(~df_integrated_current['client'].str.contains('TEMPLATE'))]

for index, row in df_integrated_current.iterrows():
    try:
        if row['SEO Campaign Type'] == 'Standard':
            if int(row['SEO [Reg] P1 KWs']) >= int(row['SEO [Reg] KPI KWs']):
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "KPI HIT"
            else:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "NOT HIT"
        elif row['SEO Campaign Type'] == 'Cluster':
            if int(row['SEO [Cluster] Clusters Hit']) >= int(row['SEO [Cluster] KPI']):
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "KPI HIT"
            else:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "NOT HIT"
        elif row['SEO Campaign Type'] == 'Special':
            if int(row['SEO KW Manual Check']) == 999:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "KPI HIT"
            else:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "NOT HIT"
    except ValueError:
        df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "INPUT KPI"
        
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
worksheet.update('A1:ZZ1',[df_integrated_current.columns.values.tolist()])

worksheet = client.open('MediaOne Backlinks Mastersheet (2024)').worksheet("Integrated Board")
worksheet.clear()
#data 
worksheet.update('A2:ZZ99999',df_integrated_current.fillna('').values.tolist())
#headers
worksheet.update('A1:ZZ1',[df_integrated_current.columns.to_list()])

worksheet = client.open('MediaOne Backlinks Mastersheet (2025)').worksheet("Integrated Board")
worksheet.clear()
#data 
worksheet.update('A2:ZZ99999',df_integrated_current.fillna('').values.tolist())
#headers
worksheet.update('A1:ZZ1',[df_integrated_current.columns.to_list()])

worksheet = client.open('Media Buy Weekly WIP').worksheet("Integrated Board")
worksheet.clear()
#data 
worksheet.update('A2:ZZ99999',df_integrated_current.fillna('').values.tolist())
#headers
worksheet.update('A1:ZZ1',[df_integrated_current.columns.to_list()])

df_integrated_current = pd.DataFrame()
count = 0

for campaign in combined_query:
    df_integrated_current.at[count,'client'] = campaign['name']
    df_integrated_current.at[count,'id'] = campaign['id']
    df_integrated_current.at[count,'group_id'] = campaign['group']['id']
    for key,value in dictionary.items():
        df_integrated_current.at[count,key] = campaign['column_values'][dictionary[key]]['text']

    count+=1
    
df_integrated_current = df_integrated_current[(~df_integrated_current['SEO Campaign Status'].str.contains('Expired'))&(~df_integrated_current['SEO Campaign Status'].str.contains('expired'))&(~df_integrated_current['client'].str.contains('TEMPLATE'))]

for index, row in df_integrated_current.iterrows():
    for i in df_integrated_current.loc[index,'client'].split(' '):
        if "://" in i:
            df_integrated_current.loc[index,'website'] = i.replace("https://","").replace("http://","").replace("www.","").rstrip("/")
            
df_integrated_current.rename(columns={"id": "integrated_item_id"},inplace=True)

df_integrated_current = df_integrated_current[df_integrated_current['[BD]Project Type'].str.contains('seo')]

df_integrated_current[['website',"integrated_item_id",'group_id']]

#Boards & Folders
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

apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2023-10'}

#list all boards

query2 = '{ boards (limit:1000) {board_folder_id name id description} }'
data = {'query' : query2}

r = requests.post(url=apiUrl, json=data, headers=headers)
board_data = r.json()
df = pd.DataFrame.from_dict(board_data['data']['boards'])

#to get the folder names
df = df.merge(df_folder,on="board_folder_id", how="left")

# Extracting client url from board description

for index, row in df[df['description'].notna()].iterrows():
    for line in df.at[index,'description'].split('\n'):
        if "Website Link:" in line:
            website = line.replace("Website Link: ","").replace("Website Link:","").replace("https://","").replace("http://","").replace("www.","").lstrip().rstrip().rstrip('/')
            df.at[index,'website'] = website
            
df.rename(columns={"id": "individual_board_id"},inplace=True)
df = df[(~df['name'].str.contains('Subitems'))&(~df['name'].str.contains('TEST'))&(~df['name'].str.contains('Subitems'))]

df_monday_cluster_current = df_integrated_current[(df_integrated_current['SEO Campaign Type']=="Cluster")&(df_integrated_current['SEO [Cluster] Total Clusters']!="")]
df_monday_cluster_current['cluster_kpi'] = 0
#df_monday_cluster_current[['clusters_kpi_percent','total_clusters','cluster_kpi']] = df_monday_cluster_current[['clusters_kpi_percent','total_clusters','cluster_kpi']].astype('int32')

df_monday_cluster_current[['SEO [Cluster] KPI %','SEO [Cluster] Total Clusters','cluster_kpi']] = df_monday_cluster_current[['SEO [Cluster] KPI %','SEO [Cluster] Total Clusters','cluster_kpi']].astype('int32')

for index, row in df_monday_cluster_current.iterrows():
    math.ceil((df_monday_cluster_current.at[index,'SEO [Cluster] KPI %']) * (df_monday_cluster_current.at[index,'SEO [Cluster] Total Clusters']/100))

#save a copy of the current values on the board
df_monday_current = df_integrated_current[df_integrated_current['SEO Campaign Status'].isin(['New Onboarding (PM)', 'Pending Renewal (Sales)',
                                   'Lived (PM)', 'Pending Website (PM)', 'Guarantee (SEO)', 'Renewed No Pause (Sales)',
                                   'Lit (SEO)', 'On Hold  - PSG (PM)', 'On Hold (PM)', 'Delayed (PM)'])]

#psg campaigns only
df_psg_monday = df_monday_current[~(df_monday_current.client.str.contains('COPY'))
                          & (df_monday_current.client.str.contains('PSG'))]

#exclude PSG campaigns
df_monday = df_monday_current[~df_monday_current.client.str.contains('PSG')]

#filter non-expired campaigns
filter_1 = ['Lived (PM)','On Hold (PM)','On Hold - PSG (PM)','Guarantee (SEO)','Lit (SEO)','Renewed No Pause','Renewed No Pause (Sales)','Pending Website (PM)','Renewed Paused','Pending Renewal (Sales)','New Onboarding (PM)']
df_monday_filtered = df_monday[df_monday['SEO Campaign Status'].isin(filter_1)]

#filter cluster kpi campaigns
df_monday_cluster = df_monday_filtered[df_monday_filtered['SEO Campaign Type']=='Cluster']

#filter Standard kpi campaigns
filter_2 = ['Standard']
df_monday_standard = df_monday_filtered[df_monday_filtered['SEO Campaign Type'].isin(filter_2)]

# SE Ranking
headers = {"Authorization": "Token 4181980cafdc89bc7bd8c7e9d26725f18cd617ef",
          "Content-Type":"application/json"}

engine_dict = {}
r = requests.get('https://api4.seranking.com/system/search-engines',headers=headers)
for engine in r.json():
    engine_dict[engine['id']] = engine['name']
    
campaign_ids = []
campaign_id_dict = {}

r = requests.get('https://api4.seranking.com/sites',headers=headers)
r.json()

for campaign in r.json():
    if campaign['keyword_count'] > 0:
        campaign_ids.append(campaign['id'])
        campaign_id_dict[campaign['id']] = campaign['title']
       
    
keyword_group_dict = {}

for campaign_id in campaign_ids:
    retry_count = 0
    success = False
    
    while retry_count < 10 and not success:
        try:
            s = requests.get('https://api4.seranking.com/keyword-groups/'+str(campaign_id), headers=headers)
            
            # If the request is successful, process the response
            for line in s.json():
                keyword_group_dict[line['id']] = line['name']
                
            print(str(campaign_ids.index(campaign_id)+1)+"/"+str(len(campaign_ids)), end='\r')
            success = True  # If successful, set success to True
        except Exception as e:
            print(f"Attempt {retry_count + 1} failed for campaign {campaign_id}. Error: {e}")
            retry_count += 1
            time.sleep(45)  # Wait 45 seconds before retrying
    if not success:
        print(f"Failed to retrieve rankings for campaign {campaign_id} after 10 attempts.")


today = datetime.today()  # Get today's date
formatted_date = today.strftime("%Y-%m-%d")

rankings_dict = {}

for campaign_id in campaign_ids:
    retry_count = 0
    success = False
    
    while retry_count < 10 and not success:
        try:
            url = f'https://api4.seranking.com/sites/{campaign_id}/positions?date_from={formatted_date}&date_to={formatted_date}'
            r = requests.get(url, headers=headers)
            
            # If the request is successful, process the response
            for keyword in r.json()[0]['keywords']:
                rankings_dict[keyword['id']] = {}
                rankings_dict[keyword['id']]['campaign_id'] = campaign_id
                rankings_dict[keyword['id']]['name'] = keyword['name']
                rankings_dict[keyword['id']]['position'] = keyword['positions'][0]['pos']
                rankings_dict[keyword['id']]['group_id'] = keyword['group_id']
                
            print(str(campaign_ids.index(campaign_id)+1)+"/"+str(len(campaign_ids)), end='\r')
            
            success = True  # If successful, set success to True
        except Exception as e:
            print(f"Attempt {retry_count + 1} failed for campaign {campaign_id}. Error: {e}")
            retry_count += 1
            time.sleep(45)  # Wait 45 seconds before retrying
    
    if not success:
        print(f"Failed to retrieve rankings for campaign {campaign_id} after 10 attempts.")

df_seranking = pd.DataFrame(rankings_dict).transpose()
df_seranking = df_seranking.reset_index(0)
df_seranking.columns = ['keyword_id','campaign_id','keyword','google_ranking','group_id']

for index, row in df_seranking.iterrows():
    df_seranking.at[index,'tag'] = keyword_group_dict[str(row['group_id'])]
    df_seranking.at[index,'title'] = campaign_id_dict[row['campaign_id']]
    
df_seranking = df_seranking[(~df_seranking['tag'].isin(["Test","FOC"])) & (~df_seranking['title'].isin(["MediaOne"]))]
df_seranking = df_seranking[['keyword','google_ranking','tag','title']]

merged = pd.merge(df_seranking,df_monday_standard,left_on='title',right_on='SE Ranking Project Name',how ='right')

#collate results for standard campaigns

campaign_ids_list = []
p1_kws_list = []
p2_kws_list = []
nos_kws_list = []
kpi_kws_list = []
company_list = []

for campaign_id in merged['integrated_item_id'].unique():
    campaign_ids_list.append(campaign_id)
    df_temp = merged[merged['integrated_item_id']==campaign_id]
    
    #p1 kws
    p1_kws_list.append(str(len(df_temp[(df_temp['google_ranking'] > 0) & (df_temp['google_ranking'] < 11)])))
    #p2 kws
    p2_kws_list.append(str(len(df_temp[(df_temp['google_ranking'] > 10) & (df_temp['google_ranking'] < 21)])))
    #no of keywords for each campaign
    nos_kws_list.append(str(len(df_temp)))
    #to check kpi
    kpi_kws_list.append(df_temp[['SEO [Reg] KPI KWs']].iloc[0]['SEO [Reg] KPI KWs'])
    #company
    company_list.append(df_temp[['title']].iloc[0].title)

df_new = pd.DataFrame(zip(campaign_ids_list, p1_kws_list,p2_kws_list,nos_kws_list,kpi_kws_list,company_list),
                      columns =['campaign_id', 'p1_kws','p2_kws','total_kws','kpi_kws','title'])

df_new.sort_values(by=['title'])

df_compare = df_new.merge(df_monday_current[df_monday_current['SEO [Reg] P1 KWs']!=""][['integrated_item_id','SEO [Reg] P1 KWs']],
                      how='left',left_on='campaign_id',right_on='integrated_item_id',suffixes=('', '_old'))

df_compare = df_compare[(df_compare['kpi_kws']!="" )& (df_compare['integrated_item_id'].notna())]
df_compare[['p1_kws','p2_kws','total_kws','kpi_kws','SEO [Reg] P1 KWs']] = df_compare[['p1_kws','p2_kws','total_kws','kpi_kws','SEO [Reg] P1 KWs']].astype('int32')
df_now_hit = df_compare[(df_compare['SEO [Reg] P1 KWs']<df_compare['kpi_kws'])&(df_compare['p1_kws']>=df_compare['kpi_kws'])]

# Send Message on Google Chat for Newly Hit Campaigns
# Path to your service account key file
service_account_file = "bubbly.json" 

# Your Google Chat Space ID (e.g., "spaces/AAAABBBBCCCCDDD")
space_id = "spaces/AAAA5DO8AyE"

text_message = "Newly KPI Hit Campaigns\n\n"

if len(df_now_hit)>0:
    for index, row in df_now_hit.iterrows():
        try:
            text_message+=row['title']+" - was "+str(row['SEO [Reg] P1 KWs'])+"/"+str(row['kpi_kws'])+", now "+str(row['p1_kws'])+"/"+str(row['kpi_kws'])+"\n"
        except:
            pass

    # Define the message content
    message = {
        "text": text_message
    }

    # Authenticate with Google Chat API
    credentials = service_account.Credentials.from_service_account_file(
        service_account_file, scopes=["https://www.googleapis.com/auth/chat.bot"])

    service = build('chat', 'v1', credentials=credentials)

    # Send the message to the Google Chat space
    response = service.spaces().messages().create(
        parent=space_id, body=message).execute()

df_now_not_hit = df_compare[(df_compare['p1_kws']<df_compare['SEO [Reg] P1 KWs'])&(df_compare['p1_kws']<df_compare['kpi_kws'])]

#now not hit

# Path to your service account key file
service_account_file = "bubbly.json" 

# Your Google Chat Space ID (e.g., "spaces/AAAABBBBCCCCDDD")
space_id = "spaces/AAAA5DO8AyE"

text_message = "Now Not Hit Campaigns\n\n"

if len(df_now_not_hit)>0:
    for index, row in df_now_not_hit.iterrows():
        try:
            text_message+=row['title']+" - was "+str(row['SEO [Reg] P1 KWs'])+"/"+str(row['kpi_kws'])+", now "+str(row['p1_kws'])+"/"+str(row['kpi_kws'])+"\n"
        except:
            pass

    # Define the message content
    message = {
        "text": text_message
    }

    # Authenticate with Google Chat API
    credentials = service_account.Credentials.from_service_account_file(
        service_account_file, scopes=["https://www.googleapis.com/auth/chat.bot"])

    service = build('chat', 'v1', credentials=credentials)

    # Send the message to the Google Chat space
    response = service.spaces().messages().create(parent=space_id, body=message).execute()
    
monday_campaign_ids_list = []
p1_kws_list = []
p2_kws_list = []

for index, row in df_new.iterrows():
    monday_campaign_ids_list.append(row['campaign_id'])
    p1_kws_list.append(row['p1_kws'])
    p2_kws_list.append(row['p2_kws'])
    
monday_campaign_ids_list = []
p1_kws_list = []
p2_kws_list = []

for index, row in df_new.iterrows():
    monday_campaign_ids_list.append(row['campaign_id'])
    p1_kws_list.append(row['p1_kws'])
    p2_kws_list.append(row['p2_kws'])
    
#Update P2 KWs

query_part_1 = 'mutation{  change_simple_column_value(item_id: '
#insert item_id / campaign_id
query_part_2 = ', board_id: 2845615047, column_id: "numbers27", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2023-10'}

for i in monday_campaign_ids_list:  
    query4 = query_part_1 +  i + query_part_2 + p2_kws_list[monday_campaign_ids_list.index(i)] + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    

#merge cluster campaigns on monday board with seo.mm
merged_cluster = pd.merge(df_seranking, 
                df_monday_cluster, 
                right_on ='SE Ranking Project Name',
                left_on = 'title',
                how ='right')

cluster_summary = (merged_cluster[(merged_cluster['google_ranking']>0) & (merged_cluster['google_ranking']<11)]).groupby(by=["title",'tag']).count()
cluster_summary = cluster_summary.reset_index()
cluster_summary = cluster_summary.groupby(by=["title"]).count()

cluster_update = pd.merge(cluster_summary[['tag']], 
                merged_cluster, 
                on ='title', 
                how ='left')

#cluster_update.drop(['clusters_hit_y'],axis=1,inplace=True)
#cluster_update.rename(columns={"clusters_hit_x": "clusters_hit"},inplace=True)

cluster_update = cluster_update.drop_duplicates(subset=['title'], keep='first')

cluster_campaign_ids_to_update_list = []
cluster_campaign_clusters_hit_list = []
 
for index, row in cluster_update[['title','integrated_item_id','tag_x']].iterrows():
    cluster_campaign_ids_to_update_list.append(row['integrated_item_id'])
    cluster_campaign_clusters_hit_list.append(row['tag_x'])
    
#update cluster kws
query_part_1 = 'mutation{  change_simple_column_value(item_id: '
#insert item_id / campaign_id
query_part_2 = ', board_id: 2845615047, column_id: "numbers_18", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

#Update cluster hit column
for i in cluster_campaign_ids_to_update_list:  
    query4 = query_part_1 +  str(i) + query_part_2 + str(cluster_campaign_clusters_hit_list[cluster_campaign_ids_to_update_list.index(i)]) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
#PSG
df_psg_seranking = df_seranking[df_seranking['title'].str.contains('PSG')]
#merge psg campaigns on monday board with seo.mm
#df_psg_seomm = df_psg_seomm.astype('str')
#df_psg_seomm = df_psg_seomm.astype({'google_ranking': 'float'})
df_psg_monday = df_psg_monday.astype('str')

psg_merged = pd.merge(df_psg_monday, 
                df_psg_seranking, 
                left_on ='SE Ranking Project Name', 
                right_on = 'title',
                how ='left')
psg_merged.dropna(subset=['title'],inplace=True)
#psg_merged['campaign_id'] = psg_merged['campaign_id'].astype(int)

#collate results for standard campaigns

campaign_ids_list = []
p1_kws_list = []
p2_kws_list = []
nos_kws_list = []
kpi_kws_list = []
company_list = []

for campaign_id in merged['integrated_item_id'].unique():
    campaign_ids_list.append(campaign_id)
    df_temp = merged[merged['integrated_item_id']==campaign_id]
    
    #p1 kws
    p1_kws_list.append(str(len(df_temp[(df_temp['google_ranking'] > 0) & (df_temp['google_ranking'] < 11)])))
    #p2 kws
    p2_kws_list.append(str(len(df_temp[(df_temp['google_ranking'] > 10) & (df_temp['google_ranking'] < 21)])))
    #no of keywords for each campaign
    nos_kws_list.append(str(len(df_temp)))
    #to check kpi
    kpi_kws_list.append(df_temp[['SEO [Reg] KPI KWs']].iloc[0]['SEO [Reg] KPI KWs'])
    #company
    company_list.append(df_temp[['title']].iloc[0].title)

df_new = pd.DataFrame(zip(campaign_ids_list, p1_kws_list,p2_kws_list,nos_kws_list,kpi_kws_list,company_list),
                      columns =['campaign_id', 'p1_kws','p2_kws','total_kws','kpi_kws','title'])

#collate results for psg campaigns

campaign_ids_list = []
p1_kws_list = []
p2_kws_list = []
nos_kws_list = []
kpi_kws_list = []
company_list = []

for campaign_id in psg_merged['integrated_item_id'].unique():
    campaign_ids_list.append(campaign_id)
    df_temp = psg_merged[psg_merged['integrated_item_id']==campaign_id]
    #p1 kws
    p1_kws_list.append(str(len(df_temp[(df_temp['google_ranking'] > 0) & ((df_temp['google_ranking']) < 11)])))
    #p2 kws
    p2_kws_list.append(str(len(df_temp[(df_temp['google_ranking'] > 10) & (df_temp['google_ranking'] < 21)])))
    #no of keywords for each campaign
    nos_kws_list.append(str(len(df_temp)))
    #to check kpi
    kpi_kws_list.append(df_temp[['SEO [Reg] KPI KWs']].iloc[0]['SEO [Reg] KPI KWs'])
    #company
    company_list.append(df_temp[['title']].iloc[0].title)

df_new_psg = pd.DataFrame(zip(campaign_ids_list, p1_kws_list,p2_kws_list,nos_kws_list,kpi_kws_list,company_list),
                      columns =['monday_campaign_id', 'p1_kws','p2_kws','total_kws','kpi_kws','title'])

df_compare_psg = df_new_psg.merge(df_monday_current[df_monday_current['SEO [Reg] P1 KWs']!=""][['integrated_item_id','SEO [Reg] P1 KWs']],
                      how='left',left_on='monday_campaign_id',right_on='integrated_item_id',suffixes=('', '_old'))

df_compare_psg.fillna('',inplace=True)
df_compare_psg = df_compare_psg[df_compare_psg['kpi_kws']!=""]
df_compare_psg = df_compare_psg[df_compare_psg['SEO [Reg] P1 KWs']!=""]

df_compare_psg[['p1_kws','p2_kws','total_kws','kpi_kws','SEO [Reg] P1 KWs']] = df_compare_psg[['p1_kws','p2_kws','total_kws','kpi_kws','SEO [Reg] P1 KWs']].astype('int32')
df_psg_now_hit = df_compare_psg[(df_compare_psg['SEO [Reg] P1 KWs']<df_compare_psg['kpi_kws'])&(df_compare_psg['p1_kws']>=df_compare_psg['kpi_kws'])]

psg_monday_campaign_ids_list = []
psg_p1_kws_list = []
psg_p2_kws_list = []

for index, row in df_new_psg.iterrows():
    psg_monday_campaign_ids_list.append(row['monday_campaign_id'])
    psg_p1_kws_list.append(row['p1_kws'])
    psg_p2_kws_list.append(row['p2_kws'])
    
monday_api_key = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjE2MTMyMzY2NywidWlkIjoyNzA4NzA3NywiaWFkIjoiMjAyMi0wNS0xOVQwNzo0Mjo1NS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NDk4MzM0NiwicmduIjoidXNlMSJ9.9-t-toyfO0RkHNHzBpHOfUwmJcfBKEaBCucIRAn6U_8"
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2025-04'}
    
#update psg 
query_part_1 = 'mutation{  change_simple_column_value(item_id: '
#insert item_id / campaign_id
query_part_2 = ', board_id: 2845615047, column_id: "numbers98", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

#Update P1 KWs
for i in psg_monday_campaign_ids_list:  
    query4 = query_part_1 +  i + query_part_2 + psg_p1_kws_list[psg_monday_campaign_ids_list.index(i)] + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')

#Update P2 KWs

query_part_1 = 'mutation{  change_simple_column_value(item_id: '
#insert item_id / campaign_id
query_part_2 = ', board_id: 2845615047, column_id: "numbers27", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

for i in psg_monday_campaign_ids_list:  
    query4 = query_part_1 +  i + query_part_2 + psg_p2_kws_list[psg_monday_campaign_ids_list.index(i)] + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')

#First Aid
df_first_aid = df_seranking[df_seranking['title'].str.contains('First Aid')]
if df_first_aid_hit.groupby(['tag']).count().at['Maintain in 1 - 5','keyword'] > 4 and df_first_aid_hit.groupby(['tag']).count().at['Push to 1 - 5','keyword'] > 0:
    #Update manual check KWs to 999",
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 5718076994, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 5718076994, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
    
#create monday update for first aid
try:
    push_to_top_5 = str(df_first_aid_hit.groupby(['tag']).count().at['Push to 1 - 5','keyword'])
except:
    push_to_top_5 = "0"
string = "KPI Keywords Hit for 'Maintain in 1-5': " + str(df_first_aid_hit.groupby(['tag']).count().at['Maintain in 1 - 5','keyword']) + "/5\n"+"KPI Keywords Hit for 'Push to 1-5': " + push_to_top_5 + "/1"+"\n\n"
string+="<table><tbody><tr><td><div>keyword</div></td><td><div>tag</div></td><td><div>ranking</div></td></tr>"

for index, row in df_first_aid.sort_values(by=['tag','google_ranking']).iterrows():
    string+=("<tr><td><div>"+row['keyword']+"</div></td>"+"<td><div>"+row['tag']+"</div></td>"+"<td><div>"+str(row['google_ranking'])+"</div></td></tr>")
    
string+="</tbody></table>"

apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 5718076994, body: "'
query_part_2 = '") {id}}'
text = string.replace('"', '\\"').replace('\n', '\\n')

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers)
print(r.json())

counter = 0

for index, row in df_first_aid.iterrows():
    if row['tag'] == "Maintain in 1 - 5" and row["google_ranking"] < 6 and row['google_ranking'] > 0:
        print(row['keyword'])
        counter+=1
        
if counter > 6:
    #Update manual check KWs to 999",
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 5718076994, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 5718076994, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
    
#create monday update for first aid
string = "KPI Keywords Hit: " + str(counter) + "/7\n\n"
string+="<table><tbody><tr><td><div>keyword</div></td><td><div>tag</div></td><td><div>ranking</div></td></tr>"

for index, row in df_first_aid.sort_values(by=['tag','google_ranking']).iterrows():
    string+=("<tr><td><div>"+row['keyword']+"</div></td>"+"<td><div>"+row['tag']+"</div></td>"+"<td><div>"+str(row['google_ranking'])+"</div></td></tr>")
    
string+="</tbody></table>"

apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 5718076994, body: "'
query_part_2 = '") {id}}'
text = string.replace('"', '\\"').replace('\n', '\\n')

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers)
print(r.json())

# That Econs Tutor
df_econs = df_seranking[df_seranking['title'].str.contains("That Econs")]

for index, row in df_econs.iterrows():
    if row['keyword'] in ["econ tuition jc", "economic tuition", "tuition for economics"]:
        df_econs.at[index, 'tag'] = "Regular"
    else:
        df_econs.at[index, 'tag'] = "Maintenance"

query_part_3 = '") { id } }'
if len(df_econs[(df_econs['tag']=="Regular")&(df_econs['google_ranking']<11)]) > 1 & len(df_econs[(df_econs['tag']=="Maintenance")&(df_econs['google_ranking']<11)]) > 3:
    #Update manual check KWs to 999",
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9511040804, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9511040804, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')


#Ma Kuang
df_makuang = df_seranking[df_seranking['title'].str.contains('Ma Kuang')]

makuang_dict = {}
for index, row in df_makuang.iterrows():
    if row['tag'] not in makuang_dict.keys():
        makuang_dict[row['tag']]= 0
    if row['google_ranking'] !=999 and row['google_ranking']< 11:
        makuang_dict[row['tag']] +=1

clusters_hit = 0

for key,value in makuang_dict.items():
    if value > 3:
        clusters_hit += 1
    makuang_dict[key] = str(value) + '/4'

string = 'Clusters Hit: ' + str(clusters_hit) + "/15 (Hit 7 - KPI HIT)\n"
for key,value in makuang_dict.items():
    string+="\n"+key+": "+value

#create monday update for makuang
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 7537978196, body: "'
query_part_2 = '") {id}}'
text = string.replace('"', '\\"').replace('\n', '\\n')

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers)
print(r.json())
query_part_3 = '") { id } }'
if clusters_hit > 6:
    #Update manual check KWs to 999",
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 7537978196, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 7537978196, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
df_gerard_id = df_seranking[df_seranking['title'].str.contains('Dr Gerard Leong (Indonesia)')]
query_part_1 = 'mutation{  change_simple_column_value(item_id: 5121313538, board_id: 2845615047, column_id: "numbers98", value: "'
query4 = query_part_1 + str(len(df_gerard_id[df_gerard_id['google_ranking']<11])) + query_part_3
data = {'query' : query4}
r = requests.post(url=apiUrl, json=data, headers=headers)
print(r.json())

query_part_1 = 'mutation{  change_simple_column_value(item_id: 5121313538, board_id: 2845615047, column_id: "numbers27", value: "'
query4 = query_part_1 + str(len(df_gerard_id[(df_gerard_id['google_ranking']>10)&(df_gerard_id['google_ranking']<21)])) + query_part_3
data = {'query' : query4}
r = requests.post(url=apiUrl, json=data, headers=headers)
print(r.json())


#Common TCM
df_common = df_seranking[df_seranking['title'].str.contains('Common')]
df_common_hit = df_common[(df_common['google_ranking']<11)&(df_common['google_ranking']>0)].groupby(['tag']).count()
if df_common_hit.at['General','keyword'] > 4 and df_common_hit.at['Maintenance','keyword'] > 9:
    #Update manual check KWs to 999
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9298658614, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9298658614, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
 
string = "General: "+str(len(df_common[(df_common['tag']=="General") & (df_common['google_ranking']<11)& (df_common['google_ranking']>0)]))+"/10 (5 to hit KPI) <br>Maintenance: "+str(len(df_common[(df_common['tag']=="Maintenance")&(df_common['google_ranking']<11)&(df_common['google_ranking']!=0)]))+"/10 (10 to hit KPI)" 

#create monday update for sata
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 9298658614, body: "'
query_part_2 = '") {id}}'
text = string

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())
    
#Anderco
monday_api_key = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjE2MTMyMzY2NywidWlkIjoyNzA4NzA3NywiaWFkIjoiMjAyMi0wNS0xOVQwNzo0Mjo1NS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NDk4MzM0NiwicmduIjoidXNlMSJ9.9-t-toyfO0RkHNHzBpHOfUwmJcfBKEaBCucIRAn6U_8"
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2025-04'}
query_part_3 = '") { id } }'

df_anderco = df_seranking[df_seranking['title'].str.contains('Anderco')]
df_anderco_hit = df_anderco[(df_anderco['google_ranking']<11)&(df_anderco['google_ranking']>0)].groupby(['tag']).count()

if len(df_anderco_hit) > 7:
    #Update manual check KWs to 999
    print("hit")
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9066886636, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simplea_column_value(item_id: 9066886636, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
string = "Clusters Hit: "+str(len(df_anderco_hit))+"/15 (KPI is 8)" 

#create monday update for sata
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 9066886636, body: "'
query_part_2 = '") {id}}'
text = string

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())

# SATA
df_sata = df_seranking[df_seranking['title'].str.contains('Sata')]
df_sata_hit = df_sata[(df_sata['google_ranking']<11)&(df_sata['google_ranking']>0)].groupby(['tag']).count()
if df_sata_hit .at['General','keyword'] > 1 and df_sata_hit .at['Maintenance','keyword'] > 13:
    #Update manual check KWs to 999
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 8579765720, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 8579765720, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
string = "General: "+str(len(df_sata[(df_sata['tag']=="General") & (df_sata['google_ranking']<11)& (df_sata['google_ranking']>0)]))+"/4 (2 to hit KPI) <br>Maintenance: "+str(len(df_sata[(df_sata['tag']=="Maintenance")&(df_sata['google_ranking']<11)&(df_sata['google_ranking']!=0)]))+"/17 (14 to hit KPI)" 

#create monday update for sata
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 8579765720, body: "'
query_part_2 = '") {id}}'
text = string

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())
    
    

#df_dior = df_seomm[df_seomm['company'].str.contains("Dior")]

df_dior = df_seranking[df_seranking['title'].str.contains('Dior')]

#df_dior = df_seomm[df_seomm['company'].str.contains("Dior")]

string = "To Maintain Page 1: "+str(len(df_dior[(df_dior['tag']=="To maintain on page 1") & (df_dior['google_ranking']<11)& (df_dior['google_ranking']>0)]))+"/45 (36 to hit KPI) <br>To Rank on Page 1: "+str(len(df_dior[(df_dior['tag']!="To maintain on page 1")&(df_dior['google_ranking']<11)&(df_dior['google_ranking']!=0)]))+"/64 (32 to hit KPI)" 

#create monday update for dior
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 9539506286, body: "'
query_part_2 = '") {id}}'
text = string

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())

if len(df_dior[(df_dior['tag']=="To maintain on page 1") & (df_dior['google_ranking']<11)& (df_dior['google_ranking']>0)])>35:
    score = 1
else:
    score = 0

if len(df_dior[(df_dior['tag']=="To rank on page 1") & (df_dior['google_ranking']<11)& (df_dior['google_ranking']>0)])>31:
    score += 1
else:
    pass

#update KPI
query_part_1 = 'mutation{  change_simple_column_value(item_id: 9539506286, board_id: 2845615047, column_id: "numbers98", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

#Update P1 KWs
query4 = query_part_1 + str(score) + query_part_3
data = {'query' : query4}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json(), end='\r')

if score == 2:
    #Update manual check KWs to 999
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9539506286, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 9539506286, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    

#legend interiors
df_legend_p1 = pd.DataFrame()
df_legend_p2 = pd.DataFrame()
counter = 0

headers = {"Authorization": "Token 4181980cafdc89bc7bd8c7e9d26725f18cd617ef",
          "Content-Type":"application/json"}

url = f'https://api4.seranking.com/sites/10231412/positions?date_from={formatted_date}&date_to={formatted_date}'

r = requests.get(url, headers=headers)

site_engine_dict = {"3098542": "Thailand","3098545":"Singapore","3090931":"Malaysia"}

for site_engine in r.json():
    for keyword in site_engine['keywords']:
        if keyword_group_dict[str(keyword['group_id'])] == "General" and keyword['positions'][0]['pos'] !=0 and keyword['positions'][0]['pos'] < 11:
            df_legend_p1.at[counter,'keyword'] = keyword['name']
            df_legend_p1.at[counter,'position'] = keyword['positions'][0]['pos']
            df_legend_p1.at[counter,'group'] = keyword_group_dict[str(keyword['group_id'])]
            df_legend_p1.at[counter,'site_engine'] = site_engine_dict[str(site_engine['site_engine_id'])]
        counter+=1   
        
counter = 0
        
for site_engine in r.json():
    for keyword in site_engine['keywords']:
        if keyword_group_dict[str(keyword['group_id'])] == "General" and keyword['positions'][0]['pos'] !=0 and keyword['positions'][0]['pos'] < 21 and keyword['positions'][0]['pos'] > 10:
            df_legend_p2.at[counter,'keyword'] = keyword['name']
            df_legend_p2.at[counter,'position'] = keyword['positions'][0]['pos']
            df_legend_p2.at[counter,'group'] = keyword_group_dict[str(keyword['group_id'])]
            df_legend_p2.at[counter,'site_engine'] = site_engine_dict[str(site_engine['site_engine_id'])]
        counter+=1  

monday_api_key = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjE2MTMyMzY2NywidWlkIjoyNzA4NzA3NywiaWFkIjoiMjAyMi0wNS0xOVQwNzo0Mjo1NS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NDk4MzM0NiwicmduIjoidXNlMSJ9.9-t-toyfO0RkHNHzBpHOfUwmJcfBKEaBCucIRAn6U_8"
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2025-04'}        

legend_p2 = {}
try:
    legend_p2['8222788388'] = legend_p2.groupby(['site_engine']).count().at['Singapore','keyword']
except:
    legend_p2['8222788388'] = 0
try:
    legend_p2['8253266685'] = legend_p2.groupby(['site_engine']).count().at['Malaysia','keyword']
except:
    legend_p2['8253266685'] = 0
try:
    legend_p2['8253270255'] = legend_p2.groupby(['site_engine']).count().at['Thailand','keyword']
except:
    legend_p2['8253270255'] = 0
    
query_part_1 = 'mutation{  change_simple_column_value(item_id: '
#insert item_id / campaign_id
query_part_2 = ', board_id: 2845615047, column_id: "numbers27", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

#Update P2 KWs
for i in legend_p2.keys():  
    query4 = query_part_1 +  i + query_part_2 + str(legend_p2[i]) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
        
legend_p1 = {}
try:
    legend_p1['8222788388'] = df_legend_p1.groupby(['site_engine']).count().at['Singapore','keyword']
except:
    legend_p1['8222788388'] = 0
try:
    legend_p1['8253266685'] = df_legend_p1.groupby(['site_engine']).count().at['Malaysia','keyword']
except:
    legend_p1['8253266685'] = 0
try:
    legend_p1['8253270255'] = df_legend_p1.groupby(['site_engine']).count().at['Thailand','keyword']
except:
    legend_p1['8253270255'] = 0
    
query_part_1 = 'mutation{  change_simple_column_value(item_id: '
#insert item_id / campaign_id
query_part_2 = ', board_id: 2845615047, column_id: "numbers98", value: "'
#insert value to be updated
query_part_3 = '") { id } }'

#Update P1 KWs
for i in legend_p1.keys():  
    query4 = query_part_1 +  i + query_part_2 + str(legend_p1[i]) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')

#ultra vault

headers = {"Authorization": "Token 4181980cafdc89bc7bd8c7e9d26725f18cd617ef",
          "Content-Type":"application/json"}
url = f'https://api4.seranking.com/sites/10231115/positions?date_from={formatted_date}&date_to={formatted_date}'
r = requests.get(url, headers=headers)

df_ultra = pd.DataFrame()
counter = 0

for engine in range(0,len(r.json())):
    for keyword in r.json()[engine]['keywords']:
        df_ultra.at[counter,'keyword'] = keyword['name']
        df_ultra.at[counter,'google_rank'] = keyword['positions'][0]['pos']
        df_ultra.at[counter,'tag'] = keyword_group_dict[str(keyword['group_id'])]
        df_ultra.at[counter,'engine_id'] = r.json()[engine]['site_engine_id']
        counter+=1
        
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}
        
if df_ultra[(df_ultra['google_rank']<11)&(df_ultra['google_rank']>0)].groupby(['tag']).count().at['General','keyword'] > 4 and df_ultra[(df_ultra['google_rank']<11)&(df_ultra['google_rank']>0)].groupby(['tag']).count().at['Maintenance','keyword'] > 9:
    #Update manual check KWs to 999",
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 7159686829, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(999) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #Update manual check KWs to 0
    query_part_1 = 'mutation{  change_simple_column_value(item_id: 7159686829, board_id: 2845615047, column_id: "numbers40", value: "'
    query4 = query_part_1 + str(0) + query_part_3
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
string = "General: "+str(len(df_ultra[(df_ultra['tag']=="General") & (df_ultra['google_rank']<11)& (df_ultra['google_rank']>0)]))+"/12 (5 to hit KPI) <br>Maintenance: "+str(len(df_ultra[(df_ultra['tag']=="Maintenance")&(df_ultra['google_rank']<11)&(df_ultra['google_rank']!=0)]))+"/8 (8 to hit KPI)" 

#create monday update for ultra
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 7159686829, body: "'
query_part_2 = '") {id}}'
text = string

query3 = query_part_1+text+query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())
    

# Extra Space
df_extra_space = df_seranking[df_seranking['title'].str.contains("Extra Space")]
df_extra_space_output = df_extra_space[['title','keyword','google_ranking']]
df_extra_space_output['storhub'] = 999

url = "https://api.dataforseo.com/v3/serp/google/organic/live/regular"
headers = {
    'Authorization': "Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM=",
    'Content-Type': 'application/json'
}

for index, row in df_extra_space_output.iterrows():
    if 'Hong Kong' in row['title']:
        if re.findall(r'([\u4e00-\u9fff]+(?: [\u4e00-\u9fff]+)*)', row['keyword']) is True:
            payload=[{"keyword":row['keyword'],
                "location_name": "Hong Kong",
                "language_name": "Chinese (Traditional)",
                "depth":100}]
        else:
            payload=[{"keyword":row['keyword'],
                "location_name": "Hong Kong",
                "language_name": "English",
                "depth":100}]
        
        response = requests.request("POST", url, headers=headers, json=payload)
        for result in response.json()['tasks'][0]['result'][0]['items']:
            if 'storhub.co' in result['url']:
                print(result['url'],result['rank_group'])
                df_extra_space_output.at[index,'storhub'] = result['rank_group']
                break
    elif 'Korea' in row['title']:
        payload=[{"keyword":row['keyword'],
            "location_name": "South Korea",
            "language_name": "Korean",
            "depth":100}]
        
        response = requests.request("POST", url, headers=headers, json=payload)
        for result in response.json()['tasks'][0]['result'][0]['items']:
            if 'storhub.co' in result['url']:
                print(result['url'],result['rank_group'])
                df_extra_space_output.at[index,'storhub'] = result['rank_group']
                break
    elif 'Malaysia' in row['title']:
        payload=[{"keyword":row['keyword'],
            "location_name": "Malaysia",
            "language_name": "English",
            "depth":100}]
        
        response = requests.request("POST", url, headers=headers, json=payload)
        for result in response.json()['tasks'][0]['result'][0]['items']:
            if 'storhub.co' in result['url']:
                print(result['url'],result['rank_group'])
                df_extra_space_output.at[index,'storhub'] = result['rank_group']
                break
                
    elif 'Singapore' in row['title']:
        payload=[{"keyword":row['keyword'],
            "location_name": "Singapore",
            "language_name": "English",
            "depth":100}]
        
        response = requests.request("POST", url, headers=headers, json=payload)
        for result in response.json()['tasks'][0]['result'][0]['items']:
            if 'storhub.co' in result['url']:
                print(result['url'],result['rank_group'])
                df_extra_space_output.at[index,'storhub'] = result['rank_group']
                break
                
string_hk = '<p>\ufeffAutomated Ranking Comparison:</p><br><table><tbody><tr><td><div>keyword</div></td><td><div>extraspace</div></td><td><div>storhub</div></td></tr>'  # Corrected opening
score = 0
for index, row in df_extra_space_output.iterrows():
    if 'Hong Kong' in row['title']:
        string_hk += f'<tr><td><div>{row["keyword"]}</div></td><td>{str(int(row["google_ranking"]))}<div></div></td><td><p>{row["storhub"]}</p></td></tr>'
        if row['google_ranking'] < row['storhub']:
            score +=1
string_hk += '</tbody></table><p>' + "Better Ranking than StorHub: "+str(score)+"/"+str(len(df_extra_space_output[df_extra_space_output['title'].str.contains('Hong Kong')]))+" or "+str(round(score/len(df_extra_space_output[df_extra_space_output['title'].str.contains('Hong Kong')])*100))+"%</p>"   # Corrected table closing

#create monday update for extra space hk
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 8065489687, body: "'
query_part_2 = '") {id}}'
text = string_hk

query3 = query_part_1 + text + query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())

if score / len(df_extra_space_output[df_extra_space_output['title'].str.contains('Hong Kong')]) >= 0.3:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 8065489687, board_id: 2845615047, column_id: "numbers40", value: "'+str(999)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 8065489687, board_id: 2845615047, column_id: "numbers40", value: "'+str(0)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
string_kr = '<p>\ufeffAutomated Ranking Comparison:</p><br><table><tbody><tr><td><div>keyword</div></td><td><div>extraspace</div></td><td><div>storhub</div></td></tr>'  # Corrected opening
score = 0
for index, row in df_extra_space_output.iterrows():
    if 'Korea' in row['title']:
        string_kr += f'<tr><td><div>{row["keyword"]}</div></td><td>{str(int(row["google_ranking"]))}<div></div></td><td><p>{row["storhub"]}</p></td></tr>'
        if row['google_ranking'] < row['storhub']:
            score +=1
string_kr += '</tbody></table><p>' + "Better Ranking than StorHub: "+str(score)+"/"+str(len(df_extra_space_output[df_extra_space_output['title'].str.contains('Korea')]))+" or "+str(round(score/len(df_extra_space_output[df_extra_space_output['title'].str.contains('Korea')])*100))+"%</p>"   # Corrected table closing

#create monday update for extra space kr
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 8065500047, body: "'
query_part_2 = '") {id}}'
text = string_kr

query3 = query_part_1 + text + query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())

if score / len(df_extra_space_output[df_extra_space_output['title'].str.contains('Korea')]) >= 0.3:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 8065500047, board_id: 2845615047, column_id: "numbers40", value: "'+str(999)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 8065500047, board_id: 2845615047, column_id: "numbers40", value: "'+str(0)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
    
string_my = '<p>\ufeffAutomated Ranking Comparison:</p><br><table><tbody><tr><td><div>keyword</div></td><td><div>extraspace</div></td><td><div>storhub</div></td></tr>'  # Corrected opening
score = 0
for index, row in df_extra_space_output.iterrows():
    if 'Malaysia' in row['title']:
        string_my += f'<tr><td><div>{row["keyword"]}</div></td><td>{str(int(row["google_ranking"]))}<div></div></td><td><p>{row["storhub"]}</p></td></tr>'
        if row['google_ranking'] < row['storhub']:
            score +=1
string_my += '</tbody></table><p>' + "Better Ranking than StorHub: "+str(score)+"/"+str(len(df_extra_space_output[df_extra_space_output['title'].str.contains('Malaysia')]))+" or "+str(score/len(df_extra_space_output[df_extra_space_output['title'].str.contains('Malaysia')])*100)+"%</p>"   # Corrected table closing

#create monday update for extra space my
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 8065455091, body: "'
query_part_2 = '") {id}}'
text = string_my

query3 = query_part_1 + text + query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())

if score / len(df_extra_space_output[df_extra_space_output['title'].str.contains('Malaysia')]) >= 0.3:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 8065455091, board_id: 2845615047, column_id: "numbers40", value: "'+str(999)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 8065455091, board_id: 2845615047, column_id: "numbers40", value: "'+str(0)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')

string_sg = '<p>\ufeffAutomated Ranking Comparison:</p><br><table><tbody><tr><td><div>keyword</div></td><td><div>extraspace</div></td><td><div>storhub</div></td></tr>'  # Corrected opening
score = 0
for index, row in df_extra_space_output.iterrows():
    if 'Singapore' in row['title']:
        string_sg += f'<tr><td><div>{row["keyword"]}</div></td><td>{str(int(row["google_ranking"]))}<div></div></td><td><p>{row["storhub"]}</p></td></tr>'
        if row['google_ranking'] < row['storhub']:
            score +=1
string_sg += '</tbody></table><p>' + "Better Ranking than StorHub: "+str(score)+"/"+str(len(df_extra_space_output[df_extra_space_output['title'].str.contains('Singapore')]))+" or "+str(round(score/len(df_extra_space_output[df_extra_space_output['title'].str.contains('Singapore')])*100))+"%</p>"   # Corrected table closing

#create monday update for extra space sg
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key}

query_part_1 = 'mutation { create_update (item_id: 7741515665, body: "'
query_part_2 = '") {id}}'
text = string_sg

query3 = query_part_1 + text + query_part_2
data = {'query' : query3}
r = requests.post(url=apiUrl, json=data, headers=headers) # make request
print(r.json())

if score / len(df_extra_space_output[df_extra_space_output['title'].str.contains('Singapore')]) >= 0.3:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 7741515665, board_id: 2845615047, column_id: "numbers40", value: "'+str(999)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')
else:
    #update manual KPI column
    query4 = 'mutation{  change_simple_column_value(item_id: 7741515665, board_id: 2845615047, column_id: "numbers40", value: "'+str(0)+'") { id } }'

    #Update cluster hit column  
    data = {'query' : query4}
    r = requests.post(url=apiUrl, json=data, headers=headers) # make request
    print(r.json(), end='\r')


monday_api_key = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjE2MTMyMzY2NywidWlkIjoyNzA4NzA3NywiaWFkIjoiMjAyMi0wNS0xOVQwNzo0Mjo1NS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NDk4MzM0NiwicmduIjoidXNlMSJ9.9-t-toyfO0RkHNHzBpHOfUwmJcfBKEaBCucIRAn6U_8"
apiUrl = "https://api.monday.com/v2"
headers = {"Authorization" : monday_api_key,
           'API-Version' : '2025-04'}

#show Integrated Campaign Info Repository Board

combined_query = []

query2 = '{boards (ids:2845615047){items_page (limit:100){cursor items { group {title id} id name column_values{ column{ id title } text value}subitems { column_values{text value}}}}}}'
data = {'query' : query2}

r = requests.post(url=apiUrl, json=data, headers=headers)
board_data = r.json()
cursor = board_data['data']['boards'][0]['items_page']['cursor']
combined_query = board_data['data']['boards'][0]['items_page']['items']

for i in range(0,5):
    query2 = '{next_items_page (limit:100, cursor:"'+cursor+'") {cursor items { group {title id} id name column_values{ column{ id title } text value}subitems { column_values{text value}}}}}'
    data = {'query' : query2}

    r = requests.post(url=apiUrl, json=data, headers=headers)
    board_data = r.json()
    cursor = board_data['data']['next_items_page']['cursor']
    combined_query+=board_data['data']['next_items_page']['items']
    time.sleep(10)

dictionary = {}
count = 0

for i in combined_query[0]['column_values']:
    dictionary.update({i['column']['title']:count})
    count+=1

df_integrated_current = pd.DataFrame()
count = 0

for campaign in combined_query:
    df_integrated_current.at[count,'client'] = campaign['name']
    df_integrated_current.at[count,'id'] = campaign['id']
    df_integrated_current.at[count,'group_id'] = campaign['group']['id']
    for key,value in dictionary.items():
        df_integrated_current.at[count,key] = campaign['column_values'][dictionary[key]]['text']

    count+=1

for index, row in df_integrated_current.iterrows():
    list = row['client'].split()
    for word in list:
        if '//' in word or '.com' in word or 'www' in word:
            df_integrated_current.at[index,'domain'] = (word.replace('https://','').replace('www.','').replace('http://','')).split('/')[0]   
#df_integrated_current['domain'].mask(df_integrated_current['client']=="https://alliedtelesis-asia.com/ (India)", 'alliedtelesis-asia.com(india)', inplace=True)

df_integrated_current = df_integrated_current[(~df_integrated_current['SEO Campaign Status'].str.contains('Expired'))&(~df_integrated_current['client'].str.contains('TEMPLATE'))]

for index, row in df_integrated_current.iterrows():
    try:
        if row['SEO Campaign Type'] == 'Standard':
            if int(row['SEO [Reg] P1 KWs']) >= int(row['SEO [Reg] KPI KWs']):
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "KPI HIT"
            else:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "NOT HIT"
        elif row['SEO Campaign Type'] == 'Cluster':
            if int(row['SEO [Cluster] Clusters Hit']) >= int(row['SEO [Cluster] KPI']):
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "KPI HIT"
            else:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "NOT HIT"
        elif row['SEO Campaign Type'] == 'Special':
            if int(row['SEO KW Manual Check']) == 999:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "KPI HIT"
            else:
                df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "NOT HIT"
    except ValueError:
        df_integrated_current.at[index,'[SEO] KPI HIT RATE'] = "Error"
    
df_updated = df_integrated_current[['client','[SEO]SEO','[SEO]Asst SEO','SEO Campaign Status','SEO Campaign Type','[SEO] KPI HIT RATE',
                       '[SEO/GEO] SEO/GEO Timeline','SEO [Total Contracted KWs]',
                         'SEO [Reg] Guaranteed KWs',
                         'SEO [Reg] Non GTY KWs',
                         'SEO [Reg] KPI KWs',
                         'SEO [Reg] P1 KWs',
                         'SEO [Reg] P2 KWs',
                         'SEO [Cluster] Total Clusters',
                         'SEO [Cluster] KPI %',
                         'SEO [Cluster] KPI',
                         'SEO [Cluster] Clusters Hit','SEO KW Manual Check']]

df_updated_1 = df_updated[df_updated['SEO Campaign Status'].isin(['Lived (PM)','Renewed No Pause (Sales)',
                                                   'Guarantee (SEO)', 'Renewed (Loyal)',
       'Delayed (PM)', 'PSG Extended Live', 'Final Report', 'SEO Consultant to Review', 'Renewed (New Timeline)', 'Lit (SEO)'])]

seo_staff = ['Kanivarasi Elanchelvan', 'Jia Jia', 'Chan Ching Yi', 'Desiree Bin']

import datetime
import calendar


def get_working_days(year):
    """
    Returns a list of datetime.date objects representing all working days (Monday-Friday)
    in the given year.

    Args:
        year (int): The year for which to calculate working days.

    Returns:
        list: A list of datetime.date objects representing working days.
    """

    working_days = []
    for month in range(1, 13):  # Iterate through all months
        for day in range(1, calendar.monthrange(year, month)[1] + 1):  # Iterate through days in the month
            date = datetime.date(year, month, day)
            if date.weekday() < 5:  # 0-4 are Monday-Friday
                working_days.append(date)
    return working_days

import datetime

def get_working_days_excluding_holidays(year, holidays):
    """
    Returns a list of datetime.date objects representing all working days (Monday-Friday)
    in the given year, excluding specified holidays.

    Args:
        year (int): The year for which to calculate working days.
        holidays (list): A list of datetime.date objects representing holidays.

    Returns:
        list: A list of datetime.date objects representing working days, excluding holidays.
    """

    working_days = get_working_days(year)
    working_days_excluding_holidays = [day for day in working_days if day not in holidays]
    return working_days_excluding_holidays

holidays = [
    datetime.date(2025, 1, 1),   # New Year's Day
    datetime.date(2025, 1, 29),  # Chinese New Year (Day 1)
    datetime.date(2025, 1, 30),  # Chinese New Year (Day 2)
    datetime.date(2025, 4, 18),  # Good Friday
    datetime.date(2025, 5, 1),   # Labour Day
    datetime.date(2025, 5, 12),  # Hari Raya Puasa (Eid al-Fitr) - tentative
    datetime.date(2025, 6, 6),   # Hari Raya Haji (Eid al-Adha) - tentative
    datetime.date(2025, 8, 9),   # National Day
    datetime.date(2025, 10, 20), # Deepavali - tentative
    datetime.date(2025, 12, 25)  # Christmas Day
]

days = get_working_days_excluding_holidays(2026, holidays)

staff = seo_staff[days.index(datetime.date.today())%4]

text_message = ''
text_message += "*" + (staff+"'s "+"KPI HIT") + "*" + "\n"
text_message +='\n'+ ("Standard Campaigns: " + str(len(df_updated_1[(df_updated_1['[SEO]SEO'].str.contains(staff))&(df_updated_1['SEO Campaign Type']=="Standard")&(df_updated_1['[SEO] KPI HIT RATE']=="KPI HIT")]))+"/" + str(len(df_updated_1[(df_updated_1['[SEO]SEO'].str.contains(staff))&(df_updated_1['SEO Campaign Type']=="Standard")])))
text_message +='\n'+ ("Cluster Campaigns: " + str(len(df_updated_1[(df_updated_1['[SEO]SEO'].str.contains(staff))&(df_updated_1['SEO Campaign Type']=="Cluster")&(df_updated_1['[SEO] KPI HIT RATE']=="KPI HIT")]))+"/" + str(len(df_updated_1[(df_updated_1['[SEO]SEO'].str.contains(staff))&(df_updated_1['SEO Campaign Type']=="Cluster")])))
text_message +='\n'+ ("Special Campaigns: " + str(len(df_updated_1[(df_updated_1['[SEO]SEO'].str.contains(staff))&(df_updated_1['SEO Campaign Type']=="Special")&(df_updated_1['[SEO] KPI HIT RATE']=="KPI HIT")]))+"/" + str(len(df_updated_1[(df_updated_1['[SEO]SEO'].str.contains(staff))&(df_updated_1['SEO Campaign Type']=="Special")])))

text_message +='\n'

for index, row in df_updated_1[df_updated_1['[SEO]SEO'].str.contains(staff)].iterrows():
    kpi_hit_rate = row['[SEO] KPI HIT RATE']
    if kpi_hit_rate == '':
        kpi_hit_rate = 'NA'
    text_message += '\n'+ (row['client'] +" | "+ kpi_hit_rate)

# Define the message content
message = {
    "text": text_message
}

# Authenticate with Google Chat API
credentials = service_account.Credentials.from_service_account_file(
    service_account_file, scopes=["https://www.googleapis.com/auth/chat.bot"])

service = build('chat', 'v1', credentials=credentials)

# Your Google Chat Space ID (e.g., "spaces/AAAABBBBCCCCDDD")
space_id = "spaces/AAAA9VgFJmA"

# Send the message to the Google Chat space
response = service.spaces().messages().create(
    parent=space_id, body=message).execute()
