import json
import requests
import os

def lambda_handler(event, context):
    # Extract data from event
    data = event.get('data', {})
    budget = event.get('budget', '')  # Default to empty string if missing
    manual = event.get('manualInput', '') #Renamed and default to empty string if missing

    # Extract and format ad format choices
    ad_formats = event.get('adFormats', {})
    selected_ad_formats = [
        "Google Display" if ad_formats.get('googleDisplay', False) else None,
        "Google Search" if ad_formats.get('googleSearch', False) else None,
        "Performance Max" if ad_formats.get('performanceMax', False) else None,
        "Facebook/Instagram" if ad_formats.get('fbIg', False) else None,
        "LinkedIn" if ad_formats.get('linkedIn', False) else None,
        "TikTok" if ad_formats.get('tikTok', False) else None
    ]
    selected_ad_formats = [format for format in selected_ad_formats if format] #Filter Nones

    # Extract other parameters
    organisational_objectives = event.get('organisationalObjectives', '')
    media_plan_location = event.get('mediaPlanLocation', 'Singapore') #Default to Singapore
    media_plan_target_audience = event.get('mediaPlanTargetAudience', '')
    media_plan_customer_personas = event.get('mediaPlanCustomerPersonas', '')
    media_plan_touchpoints = event.get('mediaPlanTouchpoints', '')
    media_plan_content_strategy = event.get('mediaPlanContentStrategy', '')
    media_plan_landing_pages = event.get('mediaPlanLandingPages', '')
    media_plan_cta = event.get('mediaPlanCta', '')
    media_plan_product_service = event.get('mediaPlanProductService', '')
    media_plan_kpis = event.get('mediaPlanKpis', '')
    media_plan_competitive_analysis = event.get('mediaPlanCompetitiveAnalysis', '')
    media_plan_compliance = event.get('mediaPlanCompliance', '')
    media_plan_technology_plan = event.get('mediaPlanTechnologyPlan', '')
    media_plan_analytics_reporting = event.get('mediaPlanAnalyticsReporting', '')
    
    # OpenAI API details
    gpt_url = "https://api.openai.com/v1/chat/completions"
    gpt_key = os.environ['GPT_KEY']


    google_benchmarks = {
    "table_1": {
        "headers": ["Industry", "Average CTR (Search)", "Average CTR (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CTR (Search)": "4.41%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Auto", "Average CTR (Search)": "4.00%", "Average CTR (GDN)": "0.60%"},
            {"Industry": "B2B", "Average CTR (Search)": "2.41%", "Average CTR (GDN)": "0.46%"},
            {"Industry": "Consumer Services", "Average CTR (Search)": "2.41%", "Average CTR (GDN)": "0.51%"},
            {"Industry": "Dating & Personals", "Average CTR (Search)": "6.05%", "Average CTR (GDN)": "0.72%"},
            {"Industry": "E-Commerce", "Average CTR (Search)": "2.69%", "Average CTR (GDN)": "0.51%"},
            {"Industry": "Education", "Average CTR (Search)": "3.78%", "Average CTR (GDN)": "0.53%"},
            {"Industry": "Employment Services", "Average CTR (Search)": "2.42%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Finance & Insurance", "Average CTR (Search)": "2.91%", "Average CTR (GDN)": "0.52%"},
            {"Industry": "Health & Medical", "Average CTR (Search)": "3.27%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Home Goods", "Average CTR (Search)": "2.44%", "Average CTR (GDN)": "0.49%"},
            {"Industry": "Industrial Services", "Average CTR (Search)": "2.61%", "Average CTR (GDN)": "0.50%"},
            {"Industry": "Legal", "Average CTR (Search)": "2.93%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Real Estate", "Average CTR (Search)": "3.71%", "Average CTR (GDN)": "1.08%"},
            {"Industry": "Technology", "Average CTR (Search)": "2.09%", "Average CTR (GDN)": "0.39%"},
            {"Industry": "Travel & Hospitality", "Average CTR (Search)": "4.68%", "Average CTR (GDN)": "0.47%"}
        ]
    },
    "table_2": {
        "headers": ["Industry", "Average CPC (Search)", "Average CPC (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CPC (Search)": "$1.43", "Average CPC (GDN)": "$0.62"},
            {"Industry": "Auto", "Average CPC (Search)": "$2.46", "Average CPC (GDN)": "$0.58"},
            {"Industry": "B2B", "Average CPC (Search)": "$3.33", "Average CPC (GDN)": "$0.79"},
            {"Industry": "Consumer Services", "Average CPC (Search)": "$6.40", "Average CPC (GDN)": "$0.81"},
            {"Industry": "Dating & Personals", "Average CPC (Search)": "$2.78", "Average CPC (GDN)": "$1.49"},
            {"Industry": "E-Commerce", "Average CPC (Search)": "$1.16", "Average CPC (GDN)": "$0.45"},
            {"Industry": "Education", "Average CPC (Search)": "$2.40", "Average CPC (GDN)": "$0.47"},
            {"Industry": "Employment Services", "Average CPC (Search)": "$2.04", "Average CPC (GDN)": "$0.78"},
            {"Industry": "Finance & Insurance", "Average CPC (Search)": "$3.44", "Average CPC (GDN)": "$0.86"},
            {"Industry": "Health & Medical", "Average CPC (Search)": "$2.62", "Average CPC (GDN)": "$0.63"},
            {"Industry": "Home Goods", "Average CPC (Search)": "$2.94", "Average CPC (GDN)": "$0.60"},
            {"Industry": "Industrial Services", "Average CPC (Search)": "$2.56", "Average CPC (GDN)": "$0.54"},
            {"Industry": "Legal", "Average CPC (Search)": "$6.75", "Average CPC (GDN)": "$0.72"},
            {"Industry": "Real Estate", "Average CPC (Search)": "$2.37", "Average CPC (GDN)": "$0.75"},
            {"Industry": "Technology", "Average CPC (Search)": "$3.80", "Average CPC (GDN)": "$0.51"},
            {"Industry": "Travel & Hospitality", "Average CPC (Search)": "$1.53", "Average CPC (GDN)": "$0.44"}
        ]
    },
    "table_3": {
        "headers": ["Industry", "Average CVR (Search)", "Average CVR (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CVR (Search)": "1.96%", "Average CVR (GDN)": "1.00%"},
            {"Industry": "Auto", "Average CVR (Search)": "6.03%", "Average CVR (GDN)": "1.19%"},
            {"Industry": "B2B", "Average CVR (Search)": "3.04%", "Average CVR (GDN)": "0.80%"},
            {"Industry": "Consumer Services", "Average CVR (Search)": "6.64%", "Average CVR (GDN)": "0.98%"},
            {"Industry": "Dating & Personals", "Average CVR (Search)": "9.64%", "Average CVR (GDN)": "3.34%"},
            {"Industry": "E-Commerce", "Average CVR (Search)": "2.81%", "Average CVR (GDN)": "0.59%"},
            {"Industry": "Education", "Average CVR (Search)": "3.39%", "Average CVR (GDN)": "0.50%"},
            {"Industry": "Employment Services", "Average CVR (Search)": "5.13%", "Average CVR (GDN)": "1.57%"},
            {"Industry": "Finance & Insurance", "Average CVR (Search)": "5.10%", "Average CVR (GDN)": "1.19%"},
            {"Industry": "Health & Medical", "Average CVR (Search)": "3.36%", "Average CVR (GDN)": "0.82%"},
            {"Industry": "Home Goods", "Average CVR (Search)": "2.70%", "Average CVR (GDN)": "0.43%"},
            {"Industry": "Industrial Services", "Average CVR (Search)": "3.37%", "Average CVR (GDN)": "0.94%"},
            {"Industry": "Legal", "Average CVR (Search)": "6.98%", "Average CVR (GDN)": "1.84%"},
            {"Industry": "Real Estate", "Average CVR (Search)": "2.47%", "Average CVR (GDN)": "0.80%"},
            {"Industry": "Technology", "Average CVR (Search)": "2.92%", "Average CVR (GDN)": "0.86%"},
            {"Industry": "Travel & Hospitality", "Average CVR (Search)": "3.55%", "Average CVR (GDN)": "0.51%"}
        ]
    },
    "table_4": {
        "headers": ["Industry", "Average CPA (Search)", "Average CPA (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CPA (Search)": "$96.55", "Average CPA (GDN)": "$70.69"},
            {"Industry": "Auto", "Average CPA (Search)": "$33.52", "Average CPA (GDN)": "$23.68"},
            {"Industry": "B2B", "Average CPA (Search)": "$116.13", "Average CPA (GDN)": "$130.36"},
            {"Industry": "Consumer Services", "Average CPA (Search)": "$90.70", "Average CPA (GDN)": "$60.48"},
            {"Industry": "Dating & Personals", "Average CPA (Search)": "$76.76", "Average CPA (GDN)": "$60.23"},
            {"Industry": "E-Commerce", "Average CPA (Search)": "$45.27", "Average CPA (GDN)": "$65.80"},
            {"Industry": "Education", "Average CPA (Search)": "$72.70", "Average CPA (GDN)": "$143.36"},
            {"Industry": "Employment Services", "Average CPA (Search)": "$48.04", "Average CPA (GDN)": "$59.47"},
            {"Industry": "Finance & Insurance", "Average CPA (Search)": "$81.93", "Average CPA (GDN)": "$56.76"},
            {"Industry": "Health & Medical", "Average CPA (Search)": "$78.09", "Average CPA (GDN)": "$72.58"},
            {"Industry": "Home Goods", "Average CPA (Search)": "$87.13", "Average CPA (GDN)": "$116.17"},
            {"Industry": "Industrial Services", "Average CPA (Search)": "$79.28", "Average CPA (GDN)": "$51.58"},
            {"Industry": "Legal", "Average CPA (Search)": "$86.02", "Average CPA (GDN)": "$39.52"},
            {"Industry": "Real Estate", "Average CPA (Search)": "$116.61", "Average CPA (GDN)": "$74.79"},
            {"Industry": "Technology", "Average CPA (Search)": "$133.52", "Average CPA (GDN)": "$103.60"},
            {"Industry": "Travel & Hospitality", "Average CPA (Search)": "$44.73", "Average CPA (GDN)": "$99.13"}
        ]
    }
}

    tiktok_benchmarks = {
        "TikTok Ad Benchmarks by Industry": {
            "headers": [
                "Industry",
                "Click-through rate (CTR)",
                "Cost per click (CPC)",
                "Cost per mille (CPM)",
                "Conversion rate (CVR)",
                "Return on ad spend (ROAS)",
                "Engagement rate (ER)"
            ],
            "rows": [
                {
                    "Industry": "Alcohol",
                    "Click-through rate (CTR)": "0.18%",
                    "Cost per click (CPC)": "$0.5",
                    "Cost per mille (CPM)": "$8",
                    "Conversion rate (CVR)": "0.8%",
                    "Return on ad spend (ROAS)": "3.5",
                    "Engagement rate (ER)": "18%"
                },
                {
                    "Industry": "Fashion",
                    "Click-through rate (CTR)": "0.25%",
                    "Cost per click (CPC)": "$0.8",
                    "Cost per mille (CPM)": "$12",
                    "Conversion rate (CVR)": "0.6%",
                    "Return on ad spend (ROAS)": "2.5",
                    "Engagement rate (ER)": "15%"
                },
                {
                    "Industry": "Financial service",
                    "Click-through rate (CTR)": "0.1%",
                    "Cost per click (CPC)": "$1.5",
                    "Cost per mille (CPM)": "$15",
                    "Conversion rate (CVR)": "0.4%",
                    "Return on ad spend (ROAS)": "1.2",
                    "Engagement rate (ER)": "8%"
                },
                {
                    "Industry": "Food & Beverage",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.6",
                    "Cost per mille (CPM)": "$9",
                    "Conversion rate (CVR)": "0.7%",
                    "Return on ad spend (ROAS)": "2.8",
                    "Engagement rate (ER)": "16%"
                },
                {
                    "Industry": "Health and Beauty",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.7",
                    "Cost per mille (CPM)": "$11",
                    "Conversion rate (CVR)": "0.6%",
                    "Return on ad spend (ROAS)": "2.5",
                    "Engagement rate (ER)": "15%"
                },
                {
                    "Industry": "Higher education",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.6",
                    "Cost per mille (CPM)": "$9",
                    "Conversion rate (CVR)": "0.7%",
                    "Return on ad spend (ROAS)": "2.8",
                    "Engagement rate (ER)": "16%"
                },
                {
                    "Industry": "Home decoration",
                    "Click-through rate (CTR)": "0.15%",
                    "Cost per click (CPC)": "$0.4",
                    "Cost per mille (CPM)": "$6",
                    "Conversion rate (CVR)": "0.5%",
                    "Return on ad spend (ROAS)": "2.2",
                    "Engagement rate (ER)": "12%"
                },
                {
                    "Industry": "Retail",
                    "Click-through rate (CTR)": "0.25%",
                    "Cost per click (CPC)": "$0.8",
                    "Cost per mille (CPM)": "$12",
                    "Conversion rate (CVR)": "0.6%",
                    "Return on ad spend (ROAS)": "2.5",
                    "Engagement rate (ER)": "15%"
                },
                {
                    "Industry": "Sports teams",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.6",
                    "Cost per mille (CPM)": "$9",
                    "Conversion rate (CVR)": "0.7%",
                    "Return on ad spend (ROAS)": "2.8",
                    "Engagement rate (ER)": "16%"
                },
                {
                    "Industry": "Tech & Software",
                    "Click-through rate (CTR)": "0.28%",
                    "Cost per click (CPC)": "$0.9",
                    "Cost per mille (CPM)": "$11",
                    "Conversion rate (CVR)": "0.5%",
                    "Return on ad spend (ROAS)": "2.2",
                    "Engagement rate (ER)": "14%"
                },
                {
                    "Industry": "Travel",
                    "Click-through rate (CTR)": "0.15%",
                    "Cost per click (CPC)": "$0.4",
                    "Cost per mille (CPM)": "$6",
                    "Conversion rate (CVR)": "0.5%",
                    "Return on ad spend (ROAS)": "2.2",
                    "Engagement rate (ER)": "12%"
                },
            {
                    "Industry": "TikTok Ads Average",
                    "Click-through rate (CTR)": "0.84%",
                    "Cost per click (CPC)": "$1",
                    "Cost per mille (CPM)": "$10",
                    "Conversion rate (CVR)": "0.46%",
                    "Return on ad spend (ROAS)": "1.67",
                    "Engagement rate (ER)": "5-16%"
                }
            ]
        }
    }

    facebook_benchmarks = {
        "Facebook Ad Benchmarks by Industry": {
            "headers": [
                "Industry",
                "Average CTR",
                "Average CPC",
                "Average CVR",
                "Average CPA"
            ],
            "rows": [
                {
                    "Industry": "Apparel",
                    "Average CTR": "1.24%",
                    "Average CPC": "$0.45",
                    "Average CVR": "4.11%",
                    "Average CPA": "$10.98"
                },
                {
                    "Industry": "Auto",
                    "Average CTR": "0.80%",
                    "Average CPC": "$2.24",
                    "Average CVR": "5.11%",
                    "Average CPA": "$43.84"
                },
                {
                    "Industry": "B2B",
                    "Average CTR": "0.78%",
                    "Average CPC": "$2.52",
                    "Average CVR": "10.63%",
                    "Average CPA": "$23.77"
                },
                {
                    "Industry": "Beauty",
                    "Average CTR": "1.16%",
                    "Average CPC": "$1.81",
                    "Average CVR": "7.10%",
                    "Average CPA": "$25.49"
                },
                {
                    "Industry": "Consumer Services",
                    "Average CTR": "0.62%",
                    "Average CPC": "$3.08",
                    "Average CVR": "9.96%",
                    "Average CPA": "$31.11"
                },
                {
                    "Industry": "Education",
                    "Average CTR": "0.73%",
                    "Average CPC": "$1.06",
                    "Average CVR": "13.58%",
                    "Average CPA": "$7.85"
                },
                {
                    "Industry": "Employment & Job Training",
                    "Average CTR": "0.47%",
                    "Average CPC": "$2.72",
                    "Average CVR": "11.73%",
                    "Average CPA": "$23.24"
                },
                {
                    "Industry": "Finance & Insurance",
                    "Average CTR": "0.56%",
                    "Average CPC": "$3.77",
                    "Average CVR": "9.09%",
                    "Average CPA": "$41.43"
                },
                {
                    "Industry": "Fitness",
                    "Average CTR": "1.01%",
                    "Average CPC": "$1.90",
                    "Average CVR": "14.29%",
                    "Average CPA": "$13.29"
                },
                {
                    "Industry": "Home Improvement",
                    "Average CTR": "0.70%",
                    "Average CPC": "$2.93",
                    "Average CVR": "6.56%",
                    "Average CPA": "$44.66"
                },
                {
                    "Industry": "Healthcare",
                    "Average CTR": "0.83%",
                    "Average CPC": "$1.32",
                    "Average CVR": "11.00%",
                    "Average CPA": "$12.31"
                },
                {
                    "Industry": "Industrial Services",
                    "Average CTR": "0.71%",
                    "Average CPC": "$2.14",
                    "Average CVR": "0.71%",
                    "Average CPA": "$38.21"
                },
                {
                    "Industry": "Legal",
                    "Average CTR": "1.61%",
                    "Average CPC": "$1.32",
                    "Average CVR": "5.60%",
                    "Average CPA": "$28.70"
                },
                {
                    "Industry": "Real Estate",
                    "Average CTR": "0.99%",
                    "Average CPC": "$1.81",
                    "Average CVR": "10.68%",
                    "Average CPA": "$16.92"
                },
                {
                    "Industry": "Retail",
                    "Average CTR": "1.59%",
                    "Average CPC": "$0.70",
                    "Average CVR": "3.26%",
                    "Average CPA": "$21.47"
                },
                {
                    "Industry": "Technology",
                    "Average CTR": "1.04%",
                    "Average CPC": "$1.27",
                    "Average CVR": "2.31%",
                    "Average CPA": "$55.21"
                },
                {
                    "Industry": "Travel & Hospitality",
                    "Average CTR": "0.90%",
                    "Average CPC": "$0.63",
                    "Average CVR": "2.82%",
                    "Average CPA": "$22.50"
                },
                {
                    "Industry": "All",
                    "Average CTR": "0.90%",
                    "Average CPC": "$1.72",
                    "Average CVR": "9.21%",
                    "Average CPA": "$18.68"
                }
            ]
        }
    }

    linkedin_benchmarks = {
        "LinkedIn Ad Benchmarks 2024": {
            "headers": [
                "Metric",
                "Value",
                "Segmentation"
            ],
            "rows": [
                {
                    "Metric": "Sponsored Content (Single Image) CTR",
                    "Value": "0.56%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Sponsored Content (Carousel) CTR",
                    "Value": "0.40%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Sponsored Content (Video) CTR",
                    "Value": "0.44%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Message Ads CTR",
                    "Value": "3%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Message Ads Open Rates",
                    "Value": "30%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "LinkedIn Document Ad CTR",
                    "Value": "0.43%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "LinkedIn Event Ad CTR",
                    "Value": "0.55%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Global CTR (Senior decision-makers)",
                    "Value": "0.55%",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "Global CTR (Junior employees)",
                    "Value": "0.60%",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "CTR (Accounting)",
                    "Value": "0.60%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Business Development)",
                    "Value": "0.65%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Education)",
                    "Value": "0.65%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Engineering)",
                    "Value": "0.57%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Finance)",
                    "Value": "0.60%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Human Resources)",
                    "Value": "0.62%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Information Technology)",
                    "Value": "0.57%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Marketing)",
                    "Value": "0.60%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Media and Communications)",
                    "Value": "0.63%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Operations)",
                    "Value": "0.55%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Product Management)",
                    "Value": "0.54%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Sales)",
                    "Value": "0.58%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (NAMER)",
                    "Value": "0.5%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (APAC)",
                    "Value": "0.8%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (EMEA)",
                    "Value": "0.6%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (LATAM)",
                    "Value": "0.7%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (Software & Internet)",
                    "Value": "0.39%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Finance Services, Insurance & Banking)",
                    "Value": "0.49%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Education)",
                    "Value": "0.42%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Hardware & Networking)",
                    "Value": "0.40%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Healthcare)",
                    "Value": "0.58%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Manufacturing)",
                    "Value": "0.49%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Media & Communication)",
                    "Value": "0.42%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Retail)",
                    "Value": "0.8%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Public Administration)",
                    "Value": "0.46%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Consumer Goods)",
                    "Value": "0.6%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Transportation & Logistics)",
                    "Value": "0.67%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Corporate Services)",
                    "Value": "0.5%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPC (Global)",
                    "Value": "$5.58",
                    "Segmentation": "All"
                },
                {
                    "Metric": "CPC (Senior decision-makers)",
                    "Value": "$6.40",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "CPC (Junior employees)",
                    "Value": "$4.40",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "CPC (Accounting)",
                    "Value": "$5.00",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Business Development)",
                    "Value": "$6.30",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Education)",
                    "Value": "$4.90",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Engineering)",
                    "Value": "$5.10",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Finance)",
                    "Value": "$6.90",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Human Resources)",
                    "Value": "$6.00",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Information Technology)",
                    "Value": "$7.90",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Marketing)",
                    "Value": "$6.80",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Media and Communications)",
                    "Value": "$5.60",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Operations)",
                    "Value": "$5.70",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Product Management)",
                    "Value": "$7.30",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Sales)",
                    "Value": "$5.40",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPM (Average)",
                    "Value": "$33.80",
                    "Segmentation": "All"
                },
                {
                    "Metric": "CPL (NAMER)",
                    "Value": "$230",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (APAC)",
                    "Value": "$80",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (EMEA)",
                    "Value": "$120",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (LATAM)",
                    "Value": "$60",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (Software & IT)",
                    "Value": "$125",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Finance)",
                    "Value": "$100",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Education)",
                    "Value": "$64",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Hardware & Networking)",
                    "Value": "$150",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Healthcare)",
                    "Value": "$125",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Manufacturing)",
                    "Value": "$100",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Media & Communications)",
                    "Value": "$65",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Retail)",
                    "Value": "$80",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Public Administration)",
                    "Value": "89",
                    "Segmentation": "Industry"
                    },
                    {
                    "Metric": "CPL (Transportation & Logistics)",
                    "Value": "60",
                    "Segmentation": "Industry"
                    },
                    {
                    "Metric": "Lead Gen Form Completion Rate (Average)",
                    "Value": "10%",
                    "Segmentation": "All"
                    },
                    {
                    "Metric": "Conversion Rate (Average)",
                    "Value": "5% - 15%",
                    "Segmentation": "All"
                    },
                    {
                    "Metric": "Sponsored Content (Non-video) Engagement Rate",
                    "Value": "0.5%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Sponsored Content (Video) Engagement Rate",
                    "Value": "1.6%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Message Ad / Inmail CTR",
                    "Value": "3.6%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Message Ad / Inmail Open rates",
                    "Value": "38%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Video View-through rate",
                    "Value": "29.5%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Video Engagement Rate",
                    "Value": "1.8%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Conversation Ads Open Rate",
                    "Value": "50%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Conversation Ads CTR",
                    "Value": "12%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Live Engagement Rate",
                    "Value": "10%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Live Attendance Rate",
                    "Value": "37%",
                    "Segmentation": "Ad Format"
                    }

                    ]
                        }
                    }
    
    prompt = f"""You are a highly skilled digital marketing expert creating a comprehensive monthly media plan. The total budget is strictly ${budget}.

    **Important: You MUST ONLY use the following ad formats: {selected_ad_formats}**.  Do not include any other ad formats in your plan.

    If an ad format is specified that is not possible or reasonable for a given platform (e.g., "Google Search" on TikTok), **do not include that platform in the plan at all**.  Explain in the "budget allocation" section why that platform was excluded due to incompatibility.

    Generate an HTML table (do not mention 'HTML table' in the response) with the following columns:
        - Ad formats
        - Budget
        - Impressions
        - CTR (Click-Through Rate)
        - Clicks
        - CPC (Cost Per Click)
        - CPM (Cost Per Mille) - applicable for LinkedIn, Facebook/Instagram, TikTok, and Google Display. Leave blank for Google Search.
        - Number of Keywords (only applicable for Google Search)
        - Leads
        - Conversion Rate (must not exceed 5%)
        - CPL (Cost Per Lead)
        - Recommended Campaign Objective for the ad platform (e.g., 'Lead Generation' for LinkedIn, 'Conversions' for Facebook, 'Website Traffic' for Google, 'App Installs for TikTok)

    Use the following industry benchmarks to guide your channel recommendations and estimations (and if no data exist for IG, use FB) if these ad formats if applcable:
        - Google Ads: {json.dumps(google_benchmarks)}
        - TikTok: {json.dumps(tiktok_benchmarks)}
        - Facebook/Instagram: {json.dumps(facebook_benchmarks)}
        - LinkedIn: {json.dumps(linkedin_benchmarks)}

    Explain the reasons for the budget allocation across channels, highlighting the strengths of each platform in achieving the organisational objectives and reaching the intended audience (also in HTML format).  If a platform is excluded due to incompatible ad formats, explain this clearly.

    Key Considerations:
        *  Assume the campaign location focus is {media_plan_location} unless channel-specific variations exist.
        *  Consider that we are targeting the [target audience] to promote: {media_plan_product_service}
        * The content should be in line with these Pillars: {media_plan_content_strategy}
        *   Incorporate information to highlight : {media_plan_touchpoints}
        *  The style should be in line with these customer personas : {media_plan_customer_personas}
        *  Landing pages can be found at: {media_plan_landing_pages}
        *  Drive traffic by highlighting the {media_plan_cta}
        *  Followed these organisational objectivess: {organisational_objectives}
        *  Monitor the following indicators for success: {media_plan_kpis}
        *  This campaign must differentiate against competitors outlined at: {media_plan_competitive_analysis}
        *  Follow these legal and ethicall guidelines {media_plan_compliance}
        *  Take into account these tech specific settings when producing: {media_plan_technology_plan}
        *  You are responsible for Analysing & Reporting and creating: {media_plan_analytics_reporting}
        *  Apply those insights to adjust : {selected_ad_formats}

        Here is specific information to consider about the company / product from their webpage : {json.dumps(data)} and the following additional information: {manual}
    """

    # OpenAI API request parameters
    querystring = {"model":"gpt-4o-mini", #You may want to make this configurable
                "messages":[{"role": "user", "content": prompt}]}
    headers = {
        "Content-Type": "application/json",
        'Authorization': gpt_key
    }

    # Make the API request
    response = requests.post(gpt_url, headers=headers, json=querystring)

    # Process the response
    try:
        response_text = response.json()['choices'][0]['message']['content']
        #Clean up the response
        cleaned_response = response_text.replace('```html','').replace('```','').replace('\n\n', '<br>').replace('#','').replace("**",'')

        # Check for empty responses
        if not cleaned_response.strip():
            raise ValueError("Received an empty response from the OpenAI API.")
        
        body = cleaned_response
    except (KeyError, ValueError, json.JSONDecodeError) as e:
        # Handle API errors gracefully
        error_message = f"Error processing OpenAI API response: {str(e)}.  Raw response: {response.text}"
        print(error_message)
        body = f"<p style='color:red;'>An error occurred while generating the media plan: {error_message}</p>"

    print(body)
    return {
        'statusCode': 200,
        'body': body
    }
