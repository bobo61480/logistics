"""
sales_data.py - Enterprise Sales Data Loader & Synthetic Data Generator
Provides high quality sales transaction datasets with calculation utilities.
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def generate_sales_data(num_records=3500, seed=42):
    np.random.seed(seed)
    
    start_date = datetime(2024, 1, 1)
    end_date = datetime(2026, 8, 1)
    time_between_dates = end_date - start_date
    days_between_dates = time_between_dates.days
    
    random_days = np.random.randint(0, days_between_dates, num_records)
    order_dates = [start_date + timedelta(days=int(d)) for d in random_days]
    order_dates.sort()
    
    regions = ["North America", "Europe", "Asia Pacific", "Latin America", "Middle East & Africa"]
    region_weights = [0.42, 0.28, 0.18, 0.08, 0.04]
    
    countries_by_region = {
        "North America": ["USA", "Canada"],
        "Europe": ["Germany", "United Kingdom", "France", "Netherlands"],
        "Asia Pacific": ["Japan", "Australia", "Singapore", "India"],
        "Latin America": ["Brazil", "Mexico"],
        "Middle East & Africa": ["UAE", "South Africa"]
    }
    
    channels = ["Direct Sales", "Online Store", "Enterprise B2B", "Retail Partner", "Reseller"]
    channel_weights = [0.35, 0.25, 0.20, 0.12, 0.08]
    
    segments = ["Enterprise", "Mid-Market", "SMB"]
    segment_weights = [0.45, 0.35, 0.20]
    
    categories = [
        "Cloud Infrastructure", 
        "Enterprise Software", 
        "Hardware Systems", 
        "SaaS Subscriptions", 
        "Professional Services"
    ]
    
    products_by_category = {
        "Cloud Infrastructure": [
            ("Cloud Compute Cluster", 4200),
            ("Database Storage Engine", 2800),
            ("IoT Edge Network Hub", 1900)
        ],
        "Enterprise Software": [
            ("Enterprise ERP Suite", 8500),
            ("AI Analytics Platform", 6400),
            ("CyberSecurity Shield Pro", 3600)
        ],
        "Hardware Systems": [
            ("High-Perf Server Rack", 11500),
            ("Workstation Array", 4800),
            ("Network Firewall Appliance", 3200)
        ],
        "SaaS Subscriptions": [
            ("Annual User License Seat", 450),
            ("Team Collaboration Hub", 850),
            ("Customer Support Engine", 1200)
        ],
        "Professional Services": [
            ("Cloud Architecture Consulting", 5500),
            ("Custom Integration Sprint", 7500),
            ("Managed Security Operations", 9200)
        ]
    }
    
    reps = [
        "Alex Morgan", "Sarah Chen", "Marcus Vance", "Elena Rostova",
        "David Kim", "Jessica Taylor", "Liam O'Connor", "Maya Patel"
    ]
    
    customers = [
        "Acme Corp", "Globex Corp", "Initech", "Umbrella Corp", "Hooli Inc",
        "Cyberdyne Systems", "Stark Industries", "Massive Dynamic", "Oceanic Tech",
        "Sterling Cooper", "Aperture Science", "Wayne Enterprises", "Soylent Corp",
        "Tyrell Corp", "Bluth Company", "LexCorp", "Pied Piper", "Dunder Mifflin"
    ]
    
    records = []
    for i in range(num_records):
        order_id = f"ORD-{10001 + i}"
        date = order_dates[i]
        
        region = np.random.choice(regions, p=region_weights)
        country = np.random.choice(countries_by_region[region])
        channel = np.random.choice(channels, p=channel_weights)
        segment = np.random.choice(segments, p=segment_weights)
        category = np.random.choice(categories)
        
        prod_tuple = products_by_category[category][np.random.randint(0, len(products_by_category[category]))]
        product_name, base_price = prod_tuple
        
        # Quantity based on segment
        if segment == "Enterprise":
            qty = np.random.randint(5, 30)
            discount = np.random.choice([0.05, 0.10, 0.15, 0.20], p=[0.3, 0.4, 0.2, 0.1])
        elif segment == "Mid-Market":
            qty = np.random.randint(2, 12)
            discount = np.random.choice([0.0, 0.05, 0.10, 0.15], p=[0.4, 0.3, 0.2, 0.1])
        else:
            qty = np.random.randint(1, 5)
            discount = np.random.choice([0.0, 0.05], p=[0.8, 0.2])
            
        unit_price = round(base_price * np.random.uniform(0.92, 1.08), 2)
        gross_amount = unit_price * qty
        discount_amount = gross_amount * discount
        revenue = gross_amount - discount_amount
        
        # Cost margin based on category
        cogs_ratio = {
            "Cloud Infrastructure": 0.42,
            "Enterprise Software": 0.18,
            "Hardware Systems": 0.62,
            "SaaS Subscriptions": 0.15,
            "Professional Services": 0.48
        }[category] + np.random.uniform(-0.04, 0.04)
        
        cogs = revenue * cogs_ratio
        profit = revenue - cogs
        margin_pct = (profit / revenue) * 100 if revenue > 0 else 0
        
        rep = np.random.choice(reps)
        customer = np.random.choice(customers)
        
        stage = np.random.choice(["Closed Won", "In Negotiation", "Proposal Sent", "Qualified Lead"], p=[0.82, 0.10, 0.05, 0.03])
        status = "Paid" if stage == "Closed Won" else np.random.choice(["Pending", "Overdue"], p=[0.8, 0.2])
        
        records.append({
            "Order ID": order_id,
            "Order Date": date,
            "Year": date.year,
            "Quarter": f"{date.year}-Q{(date.month - 1) // 3 + 1}",
            "Month": date.strftime("%Y-%m"),
            "Customer": customer,
            "Segment": segment,
            "Region": region,
            "Country": country,
            "Channel": channel,
            "Category": category,
            "Product": product_name,
            "Sales Rep": rep,
            "Unit Price": round(unit_price, 2),
            "Quantity": qty,
            "Discount %": round(discount * 100, 1),
            "Gross Amount": round(gross_amount, 2),
            "Discount Amount": round(discount_amount, 2),
            "Revenue": round(revenue, 2),
            "COGS": round(cogs, 2),
            "Profit": round(profit, 2),
            "Profit Margin %": round(margin_pct, 1),
            "Deal Stage": stage,
            "Payment Status": status
        })
        
    df = pd.DataFrame(records)
    df["Order Date"] = pd.to_datetime(df["Order Date"])
    return df

def load_data(uploaded_file=None):
    if uploaded_file is not None:
        try:
            df = pd.read_csv(uploaded_file)
            if "Order Date" in df.columns:
                df["Order Date"] = pd.to_datetime(df["Order Date"])
            return df
        except Exception as e:
            st.error(f"Error loading uploaded CSV: {e}")
            return generate_sales_data()
    return generate_sales_data()

def format_currency(amount):
    if abs(amount) >= 1_000_000:
        return f"${amount / 1_000_000:.2f}M"
    elif abs(amount) >= 1_000:
        return f"${amount / 1_000:.1f}K"
    else:
        return f"${amount:,.2f}"

def format_number(val):
    if abs(val) >= 1_000_000:
        return f"{val / 1_000_000:.2f}M"
    elif abs(val) >= 1_000:
        return f"{val / 1_000:.1f}K"
    else:
        return f"{val:,}"

def format_percent(val):
    prefix = "+" if val > 0 else ""
    return f"{prefix}{val:.1f}%"
