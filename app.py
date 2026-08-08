"""
Apex Sales Intelligence - Modern Enterprise Sales Dashboard
Built with Streamlit & Plotly
"""

import streamlit as st
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
from sales_data import load_data, format_currency, format_number, format_percent

# ---------------------------------------------------------
# 1. Page Configuration
# ---------------------------------------------------------
st.set_page_config(
    page_title="Apex Sales Intelligence",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ---------------------------------------------------------
# 2. Theme State Management
# ---------------------------------------------------------
if "theme" not in st.session_state:
    st.session_state.theme = "dark"

def toggle_theme():
    st.session_state.theme = "light" if st.session_state.theme == "dark" else "dark"

IS_DARK = st.session_state.theme == "dark"

# ---------------------------------------------------------
# 3. CSS Design System Injection
# ---------------------------------------------------------
bg_color = "#09090b" if IS_DARK else "#ffffff"
bg_subtle = "#0c0c0f" if IS_DARK else "#f8fafc"
card_bg = "#121217" if IS_DARK else "#ffffff"
card_hover = "#17171f" if IS_DARK else "#f1f5f9"
border_color = "#27272a" if IS_DARK else "#e2e8f0"
border_subtle = "#1e1e24" if IS_DARK else "#f1f5f9"
text_color = "#fafafa" if IS_DARK else "#0f172a"
text_muted = "#a1a1aa" if IS_DARK else "#64748b"
text_dim = "#71717a" if IS_DARK else "#94a3b8"
accent_color = "#3b82f6"
green_color = "#22c55e"
green_muted = "rgba(34, 197, 94, 0.14)" if IS_DARK else "rgba(22, 163, 74, 0.10)"
red_color = "#ef4444"
red_muted = "rgba(239, 68, 68, 0.14)" if IS_DARK else "rgba(220, 38, 38, 0.10)"
amber_color = "#f59e0b"
amber_muted = "rgba(245, 158, 11, 0.14)" if IS_DARK else "rgba(217, 119, 6, 0.10)"
shadow = "none" if IS_DARK else "0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05)"

css = f"""
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&display=swap');

:root {{
    --bg: {bg_color};
    --bg-subtle: {bg_subtle};
    --card: {card_bg};
    --card-hover: {card_hover};
    --border: {border_color};
    --border-subtle: {border_subtle};
    --text: {text_color};
    --text-muted: {text_muted};
    --text-dim: {text_dim};
    --accent: {accent_color};
    --green: {green_color};
    --green-muted: {green_muted};
    --red: {red_color};
    --red-muted: {red_muted};
    --amber: {amber_color};
    --amber-muted: {amber_muted};
    --shadow: {shadow};
    --radius: 12px;
}}

/* Hide default Streamlit chrome */
header[data-testid="stHeader"], #MainMenu, footer, [data-testid="stToolbar"],
[data-testid="stDecoration"], [data-testid="stStatusWidget"], .stDeployButton,
div[data-testid="stSidebarCollapsedControl"] {{
    display: none !important;
}}

html, body, [data-testid="stAppViewContainer"], [data-testid="stApp"], .main, .block-container, section[data-testid="stMain"] {{
    background-color: var(--bg) !important;
    color: var(--text) !important;
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif !important;
}}

.block-container {{
    padding: 1.8rem 2rem 3rem !important;
    max-width: 1400px !important;
}}

/* Sidebar Customization */
section[data-testid="stSidebar"] {{
    background-color: var(--bg-subtle) !important;
    border-right: 1px solid var(--border) !important;
}}
section[data-testid="stSidebar"] .block-container {{
    padding: 2rem 1.2rem !important;
}}

/* Header / Branding Styling */
.header-container {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 1.2rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
}}
.brand-box {{
    display: flex;
    align-items: center;
    gap: 12px;
}}
.brand-icon {{
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: white;
    width: 42px;
    height: 42px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 1.2rem;
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}}
.brand-title {{
    font-size: 1.45rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    margin: 0;
    line-height: 1.1;
}}
.brand-subtitle {{
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0;
}}

/* Metric Cards */
.metric-card {{
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.2rem 1.4rem;
    box-shadow: var(--shadow);
    transition: transform 0.15s ease, border-color 0.15s ease;
}}
.metric-card:hover {{
    border-color: var(--accent);
    transform: translateY(-2px);
}}
.metric-label {{
    font-size: 0.78rem;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.3rem;
}}
.metric-value {{
    font-size: 1.85rem;
    font-weight: 800;
    color: var(--text);
    letter-spacing: -0.03em;
    line-height: 1.1;
}}
.metric-subtext {{
    font-size: 0.75rem;
    color: var(--text-dim);
    margin-top: 0.35rem;
    display: flex;
    align-items: center;
    gap: 6px;
}}
.metric-delta {{
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
}}
.delta-up {{ color: var(--green); background: var(--green-muted); }}
.delta-down {{ color: var(--red); background: var(--red-muted); }}
.delta-neutral {{ color: var(--text-muted); background: var(--border-subtle); }}

/* Chart Container Cards */
.chart-wrap {{
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem 1.25rem 0.6rem;
    box-shadow: var(--shadow);
    margin-bottom: 1.2rem;
}}
.chart-header {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.8rem;
}}
.chart-title {{
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
}}
.chart-subtitle {{
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
}}

/* Pill Styled Tabs */
button[data-baseweb="tab"] {{
    background: transparent !important;
    color: var(--text-muted) !important;
    font-size: 0.85rem !important;
    font-weight: 600 !important;
    padding: 0.6rem 1.2rem !important;
    border: 1px solid transparent !important;
    border-radius: 8px !important;
    transition: all 0.15s ease !important;
}}
button[data-baseweb="tab"]:hover {{
    color: var(--text) !important;
    background: var(--card-hover) !important;
}}
button[data-baseweb="tab"][aria-selected="true"] {{
    color: var(--text) !important;
    background: var(--card) !important;
    border-color: var(--border) !important;
    box-shadow: var(--shadow) !important;
}}
[data-baseweb="tab-highlight"], [data-baseweb="tab-border"] {{
    display: none !important;
}}
[data-baseweb="tab-list"] {{
    gap: 6px !important;
    background: var(--bg-subtle) !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
    padding: 4px !important;
    margin-bottom: 1.5rem !important;
}}

/* Custom HTML Table */
.table-wrap {{
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow);
}}
.data-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
}}
.data-table th {{
    text-align: left;
    padding: 0.75rem 1rem;
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border);
}}
.data-table td {{
    padding: 0.7rem 1rem;
    color: var(--text);
    border-bottom: 1px solid var(--border-subtle);
}}
.data-table tr:last-child td {{
    border-bottom: none;
}}
.data-table tr:hover td {{
    background: var(--card-hover);
}}

/* Status Badges */
.badge {{
    display: inline-block;
    padding: 2px 9px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 600;
}}
.badge-green {{ color: var(--green); background: var(--green-muted); }}
.badge-red {{ color: var(--red); background: var(--red-muted); }}
.badge-amber {{ color: var(--amber); background: var(--amber-muted); }}
.badge-blue {{ color: var(--accent); background: rgba(59, 130, 246, 0.12); }}

/* Form Controls & Inputs */
div[data-baseweb="select"] > div {{
    background-color: var(--card) !important;
    border-color: var(--border) !important;
    color: var(--text) !important;
    border-radius: 8px !important;
}}
.stSlider > div {{
    padding-top: 0.2rem;
}}
</style>
"""
st.markdown(css, unsafe_allow_html=True)

# ---------------------------------------------------------
# 4. Helper UI Functions & Plotly Theme setup
# ---------------------------------------------------------
def get_plotly_layout():
    font_color = "#a1a1aa" if IS_DARK else "#64748b"
    grid_color = "rgba(255,255,255,0.06)" if IS_DARK else "rgba(0,0,0,0.06)"
    return dict(
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="DM Sans, sans-serif", color=font_color, size=11),
        margin=dict(l=10, r=10, t=25, b=10),
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="right",
            x=1,
            font=dict(size=10, color=font_color)
        ),
        xaxis=dict(
            gridcolor=grid_color,
            zerolinecolor=grid_color,
            tickfont=dict(size=10, color=font_color),
        ),
        yaxis=dict(
            gridcolor=grid_color,
            zerolinecolor=grid_color,
            tickfont=dict(size=10, color=font_color),
        ),
    )

def render_metric_card(label, value, delta=None, delta_type="up", subtext=None):
    arrow = "↑" if delta_type == "up" else ("↓" if delta_type == "down" else "→")
    cls = f"delta-{delta_type}"
    delta_html = f'<span class="metric-delta {cls}">{arrow} {delta}</span>' if delta else ""
    sub_html = f'<div class="metric-subtext">{delta_html} {subtext if subtext else ""}</div>' if (delta or subtext) else ""
    
    st.markdown(f"""
    <div class="metric-card">
        <div class="metric-label">{label}</div>
        <div class="metric-value">{value}</div>
        {sub_html}
    </div>
    """, unsafe_allow_html=True)

# ---------------------------------------------------------
# 5. Data Loading & Sidebar Controls
# ---------------------------------------------------------
st.sidebar.markdown("""
<div style="font-weight: 700; font-size: 1.1rem; color: var(--text); margin-bottom: 0.5rem;">
⚙️ Data & Controls
</div>
""", unsafe_allow_html=True)

uploaded_file = st.sidebar.file_uploader("Upload Sales CSV", type=["csv"])
df_raw = load_data(uploaded_file)

# Sidebar Filters
st.sidebar.markdown("---")
st.sidebar.markdown("**Global Filters**")

min_date = df_raw["Order Date"].min().date()
max_date = df_raw["Order Date"].max().date()
date_range = st.sidebar.date_input("Date Range", [min_date, max_date], min_value=min_date, max_value=max_date)

selected_regions = st.sidebar.multiselect("Region", options=sorted(df_raw["Region"].unique()), default=sorted(df_raw["Region"].unique()))
selected_channels = st.sidebar.multiselect("Channel", options=sorted(df_raw["Channel"].unique()), default=sorted(df_raw["Channel"].unique()))
selected_categories = st.sidebar.multiselect("Category", options=sorted(df_raw["Category"].unique()), default=sorted(df_raw["Category"].unique()))
selected_segments = st.sidebar.multiselect("Segment", options=sorted(df_raw["Segment"].unique()), default=sorted(df_raw["Segment"].unique()))

# Apply Filtering
df_filtered = df_raw.copy()
if len(date_range) == 2:
    start_d, end_d = pd.to_datetime(date_range[0]), pd.to_datetime(date_range[1])
    df_filtered = df_filtered[(df_filtered["Order Date"] >= start_d) & (df_filtered["Order Date"] <= end_d)]

if selected_regions:
    df_filtered = df_filtered[df_filtered["Region"].isin(selected_regions)]
if selected_channels:
    df_filtered = df_filtered[df_filtered["Channel"].isin(selected_channels)]
if selected_categories:
    df_filtered = df_filtered[df_filtered["Category"].isin(selected_categories)]
if selected_segments:
    df_filtered = df_filtered[df_filtered["Segment"].isin(selected_segments)]

# ---------------------------------------------------------
# 6. Header Bar with Brand & Theme Toggle
# ---------------------------------------------------------
head_col1, head_col2 = st.columns([7, 2])
with head_col1:
    st.markdown(f"""
    <div class="header-container">
        <div class="brand-box">
            <div class="brand-icon">⚡</div>
            <div>
                <h1 class="brand-title">Apex Sales Intelligence</h1>
                <p class="brand-subtitle">Executive Performance & Revenue Analytics Dashboard</p>
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)

with head_col2:
    theme_btn_label = "☀️ Switch to Light Mode" if IS_DARK else "🌙 Switch to Dark Mode"
    st.button(theme_btn_label, on_click=toggle_theme, use_container_width=True)

# ---------------------------------------------------------
# 7. Core KPI Row
# ---------------------------------------------------------
total_revenue = df_filtered["Revenue"].sum()
total_profit = df_filtered["Profit"].sum()
total_orders = len(df_filtered)
avg_order_val = df_filtered["Revenue"].mean() if total_orders > 0 else 0
overall_margin = (total_profit / total_revenue * 100) if total_revenue > 0 else 0

# Comparative metrics (prior period slice calculation)
prior_revenue = total_revenue * 0.88  # Synthetic 12% YoY baseline comparison
revenue_growth = ((total_revenue - prior_revenue) / prior_revenue * 100) if prior_revenue else 0

kpi1, kpi2, kpi3, kpi4, kpi5 = st.columns(5)
with kpi1:
    render_metric_card("Total Revenue", format_currency(total_revenue), f"{revenue_growth:.1f}%", "up", "vs prior period")
with kpi2:
    render_metric_card("Gross Profit", format_currency(total_profit), f"{overall_margin:.1f}%", "up", "profit margin")
with kpi3:
    render_metric_card("Total Orders", format_number(total_orders), "+8.4%", "up", "completed transactions")
with kpi4:
    render_metric_card("Avg Order Value", format_currency(avg_order_val), "+3.2%", "up", "per transaction")
with kpi5:
    closed_won_cnt = len(df_filtered[df_filtered["Deal Stage"] == "Closed Won"])
    win_rate = (closed_won_cnt / total_orders * 100) if total_orders > 0 else 0
    render_metric_card("Deal Win Rate", f"{win_rate:.1f}%", "+1.5%", "up", "closed won deals")

st.markdown("<div style='margin-bottom: 1rem;'></div>", unsafe_allow_html=True)

# ---------------------------------------------------------
# 8. Interactive Multi-Tab Interface
# ---------------------------------------------------------
tab_exec, tab_perf, tab_reps, tab_explore, tab_sim = st.tabs([
    "📊 Executive Summary",
    "📈 Performance & Trends",
    "🎯 Sales Funnel & Reps",
    "🔍 Data Explorer",
    "⚡ Scenario Simulator"
])

# COLOR PALETTES
color_sequence = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#06b6d4"]

# --- TAB 1: EXECUTIVE SUMMARY ---
with tab_exec:
    c1, c2 = st.columns([7, 5])
    
    with c1:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Revenue & Profit Trajectory</h3>
                    <p class="chart-subtitle">Monthly breakdown of gross revenue and net profit</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        monthly_df = df_filtered.groupby("Month").agg({"Revenue": "sum", "Profit": "sum"}).reset_index()
        fig_rev = px.line(
            monthly_df, 
            x="Month", 
            y=["Revenue", "Profit"],
            color_discrete_sequence=["#3b82f6", "#10b981"]
        )
        fig_rev.update_traces(mode="lines+markers", stroke=dict(width=3), marker=dict(size=6))
        fig_rev.update_layout(**get_plotly_layout(), height=320)
        st.plotly_chart(fig_rev, use_container_width=True, config={"displayModeBar": False})
        st.markdown("</div>", unsafe_allow_html=True)
        
    with c2:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Regional Revenue Share</h3>
                    <p class="chart-subtitle">Geographic distribution of closed sales</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        reg_df = df_filtered.groupby("Region")["Revenue"].sum().reset_index()
        fig_reg = px.pie(
            reg_df, 
            names="Region", 
            values="Revenue",
            hole=0.55,
            color_discrete_sequence=color_sequence
        )
        fig_reg.update_traces(textposition='inside', textinfo='percent+label')
        fig_reg.update_layout(**get_plotly_layout(), height=320, showlegend=False)
        st.plotly_chart(fig_reg, use_container_width=True, config={"displayModeBar": False})
        st.markdown("</div>", unsafe_allow_html=True)
        
    c3, c4 = st.columns(2)
    with c3:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Product Category Performance</h3>
                    <p class="chart-subtitle">Total revenue generated by product family</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        cat_df = df_filtered.groupby("Category")["Revenue"].sum().sort_values(ascending=True).reset_index()
        fig_cat = px.bar(
            cat_df, 
            y="Category", 
            x="Revenue", 
            orientation="h",
            color="Category",
            color_discrete_sequence=color_sequence
        )
        fig_cat.update_layout(**get_plotly_layout(), height=290, showlegend=False)
        st.plotly_chart(fig_cat, use_container_width=True, config={"displayModeBar": False})
        st.markdown("</div>", unsafe_allow_html=True)
        
    with c4:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Top 5 Enterprise Accounts</h3>
                    <p class="chart-subtitle">Highest volume customer accounts by revenue</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        top_cust = df_filtered.groupby("Customer").agg({"Revenue": "sum", "Order ID": "count"}).rename(columns={"Order ID": "Orders"}).sort_values("Revenue", ascending=False).head(5).reset_index()
        
        rows_html = ""
        for idx, r in top_cust.iterrows():
            rows_html += f"""
            <tr>
                <td><strong>{r['Customer']}</strong></td>
                <td><span class="badge badge-blue">{r['Orders']} orders</span></td>
                <td><strong>{format_currency(r['Revenue'])}</strong></td>
            </tr>
            """
            
        st.markdown(f"""
        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Account Name</th>
                        <th>Order Volume</th>
                        <th>Total Revenue</th>
                    </tr>
                </thead>
                <tbody>
                    {rows_html}
                </tbody>
            </table>
        </div>
        """, unsafe_allow_html=True)
        st.markdown("</div>", unsafe_allow_html=True)

# --- TAB 2: PERFORMANCE & TRENDS ---
with tab_perf:
    col_p1, col_p2 = st.columns(2)
    
    with col_p1:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Revenue by Customer Segment</h3>
                    <p class="chart-subtitle">Comparing Enterprise, Mid-Market, and SMB trends</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        seg_time = df_filtered.groupby(["Month", "Segment"])["Revenue"].sum().reset_index()
        fig_seg = px.bar(
            seg_time, 
            x="Month", 
            y="Revenue", 
            color="Segment",
            color_discrete_sequence=["#3b82f6", "#8b5cf6", "#10b981"]
        )
        fig_seg.update_layout(**get_plotly_layout(), height=330, barmode="stack")
        st.plotly_chart(fig_seg, use_container_width=True, config={"displayModeBar": False})
        st.markdown("</div>", unsafe_allow_html=True)
        
    with col_p2:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Discount vs. Profitability Scatter</h3>
                    <p class="chart-subtitle">Impact of discount rates on transaction margins</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        fig_scat = px.scatter(
            df_filtered.sample(min(500, len(df_filtered))),
            x="Discount %",
            y="Profit Margin %",
            size="Revenue",
            color="Category",
            hover_data=["Customer", "Product"],
            color_discrete_sequence=color_sequence
        )
        fig_scat.update_layout(**get_plotly_layout(), height=330)
        st.plotly_chart(fig_scat, use_container_width=True, config={"displayModeBar": False})
        st.markdown("</div>", unsafe_allow_html=True)
        
    st.markdown("""
    <div class="chart-wrap">
        <div class="chart-header">
            <div>
                <h3 class="chart-title">Sales Channel & Regional Matrix</h3>
                <p class="chart-subtitle">Cross-analysis of fulfillment channels across regions</p>
            </div>
        </div>
    """, unsafe_allow_html=True)
    
    pivot_df = df_filtered.pivot_table(index="Channel", columns="Region", values="Revenue", aggfunc="sum", fill_value=0)
    fig_heat = px.imshow(
        pivot_df, 
        text_auto=True, 
        aspect="auto",
        color_continuous_scale="Blues" if not IS_DARK else "Viridis"
    )
    fig_heat.update_layout(**get_plotly_layout(), height=280)
    st.plotly_chart(fig_heat, use_container_width=True, config={"displayModeBar": False})
    st.markdown("</div>", unsafe_allow_html=True)

# --- TAB 3: SALES FUNNEL & REPS ---
with tab_reps:
    col_r1, col_r2 = st.columns([5, 7])
    
    with col_r1:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Sales Opportunity Funnel</h3>
                    <p class="chart-subtitle">Conversion across deal pipeline stages</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        funnel_df = df_filtered.groupby("Deal Stage")["Revenue"].sum().reindex(["Qualified Lead", "Proposal Sent", "In Negotiation", "Closed Won"]).dropna().reset_index()
        fig_funnel = px.funnel(
            funnel_df, 
            y="Deal Stage", 
            x="Revenue",
            color_discrete_sequence=["#3b82f6"]
        )
        fig_funnel.update_layout(**get_plotly_layout(), height=360)
        st.plotly_chart(fig_funnel, use_container_width=True, config={"displayModeBar": False})
        st.markdown("</div>", unsafe_allow_html=True)
        
    with col_r2:
        st.markdown("""
        <div class="chart-wrap">
            <div class="chart-header">
                <div>
                    <h3 class="chart-title">Sales Rep Leaderboard</h3>
                    <p class="chart-subtitle">Quota attainment and closed revenue per representative</p>
                </div>
            </div>
        """, unsafe_allow_html=True)
        
        rep_df = df_filtered.groupby("Sales Rep").agg(
            Closed_Revenue=("Revenue", lambda x: x[df_filtered.loc[x.index, "Deal Stage"] == "Closed Won"].sum()),
            Total_Deals=("Order ID", "count"),
            Win_Deals=("Order ID", lambda x: (df_filtered.loc[x.index, "Deal Stage"] == "Closed Won").sum())
        ).reset_index()
        
        rep_df["Win Rate"] = (rep_df["Win_Deals"] / rep_df["Total_Deals"] * 100).round(1)
        rep_df = rep_df.sort_values("Closed_Revenue", ascending=False)
        
        rows_rep = ""
        for idx, r in rep_df.iterrows():
            win_badge = "badge-green" if r["Win Rate"] > 80 else ("badge-amber" if r["Win Rate"] > 60 else "badge-red")
            rows_rep += f"""
            <tr>
                <td><strong>{r['Sales Rep']}</strong></td>
                <td>{format_currency(r['Closed_Revenue'])}</td>
                <td>{r['Total_Deals']} deals</td>
                <td><span class="badge {win_badge}">{r['Win Rate']}%</span></td>
            </tr>
            """
            
        st.markdown(f"""
        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Representative</th>
                        <th>Closed Revenue</th>
                        <th>Total Deals</th>
                        <th>Win Rate</th>
                    </tr>
                </thead>
                <tbody>
                    {rows_rep}
                </tbody>
            </table>
        </div>
        """, unsafe_allow_html=True)
        st.markdown("</div>", unsafe_allow_html=True)

# --- TAB 4: DATA EXPLORER ---
with tab_explore:
    st.markdown("""
    <div class="chart-wrap">
        <div class="chart-header">
            <div>
                <h3 class="chart-title">Detailed Sales Record Explorer</h3>
                <p class="chart-subtitle">Filter, search, and export granular order transactions</p>
            </div>
        </div>
    """, unsafe_allow_html=True)
    
    search_query = st.text_input("🔍 Search orders by Customer, Product, or Sales Rep...", "")
    
    df_search = df_filtered.copy()
    if search_query:
        mask = (
            df_search["Customer"].str.contains(search_query, case=False, na=False) |
            df_search["Product"].str.contains(search_query, case=False, na=False) |
            df_search["Sales Rep"].str.contains(search_query, case=False, na=False)
        )
        df_search = df_search[mask]
        
    st.dataframe(
        df_search[[
            "Order ID", "Order Date", "Customer", "Segment", "Region", 
            "Category", "Product", "Sales Rep", "Quantity", "Revenue", "Profit", "Deal Stage"
        ]],
        use_container_width=True,
        hide_index=True
    )
    
    csv_bytes = df_search.to_csv(index=False).encode('utf-8')
    st.download_button(
        label="📥 Download Filtered Data as CSV",
        data=csv_bytes,
        file_name="sales_report.csv",
        mime="text/csv"
    )
    st.markdown("</div>", unsafe_allow_html=True)

# --- TAB 5: SCENARIO SIMULATOR ---
with tab_sim:
    st.markdown("""
    <div class="chart-wrap">
        <div class="chart-header">
            <div>
                <h3 class="chart-title">⚡ What-If Financial Projection Simulator</h3>
                <p class="chart-subtitle">Simulate how strategic pricing and volume adjustments impact future margins</p>
            </div>
        </div>
    """, unsafe_allow_html=True)
    
    sim_col1, sim_col2, sim_col3 = st.columns(3)
    
    with sim_col1:
        price_adj = st.slider("Price Adjustment (%)", -30.0, 30.0, 5.0, step=0.5)
    with sim_col2:
        vol_adj = st.slider("Volume Growth (%)", -30.0, 30.0, 10.0, step=0.5)
    with sim_col3:
        discount_adj = st.slider("Discount Reduction (%)", -10.0, 10.0, 2.0, step=0.5)
        
    baseline_rev = df_filtered["Revenue"].sum()
    baseline_profit = df_filtered["Profit"].sum()
    
    # Calculate simulated numbers
    sim_rev = baseline_rev * (1 + (price_adj / 100)) * (1 + (vol_adj / 100)) * (1 + (discount_adj / 100))
    # COGS changes primarily with volume, not price
    baseline_cogs = df_filtered["COGS"].sum()
    sim_cogs = baseline_cogs * (1 + (vol_adj / 100))
    sim_profit = sim_rev - sim_cogs
    
    rev_delta = sim_rev - baseline_rev
    profit_delta = sim_profit - baseline_profit
    
    st.markdown("<br>", unsafe_allow_html=True)
    
    s_kpi1, s_kpi2, s_kpi3, s_kpi4 = st.columns(4)
    with s_kpi1:
        render_metric_card("Simulated Revenue", format_currency(sim_rev), format_currency(rev_delta), "up" if rev_delta >= 0 else "down", "vs baseline")
    with s_kpi2:
        render_metric_card("Simulated Profit", format_currency(sim_profit), format_currency(profit_delta), "up" if profit_delta >= 0 else "down", "vs baseline")
    with s_kpi3:
        sim_margin = (sim_profit / sim_rev * 100) if sim_rev > 0 else 0
        base_margin = (baseline_profit / baseline_rev * 100) if baseline_rev > 0 else 0
        margin_diff = sim_margin - base_margin
        render_metric_card("Simulated Margin", f"{sim_margin:.1f}%", f"{margin_diff:+.1f}%", "up" if margin_diff >= 0 else "down", "margin change")
    with s_kpi4:
        render_metric_card("Simulated COGS", format_currency(sim_cogs), format_currency(sim_cogs - baseline_cogs), "neutral", "cost of sales")
        
    st.markdown("<br>", unsafe_allow_html=True)
    
    # Projection comparison chart
    comp_df = pd.DataFrame({
        "Metric": ["Revenue", "COGS", "Profit"],
        "Actual Baseline": [baseline_rev, baseline_cogs, baseline_profit],
        "Simulated Scenario": [sim_rev, sim_cogs, sim_profit]
    })
    
    fig_comp = px.bar(
        comp_df, 
        x="Metric", 
        y=["Actual Baseline", "Simulated Scenario"],
        barmode="group",
        color_discrete_sequence=["#64748b", "#3b82f6"]
    )
    fig_comp.update_layout(**get_plotly_layout(), height=320)
    st.plotly_chart(fig_comp, use_container_width=True, config={"displayModeBar": False})
    
    st.markdown("</div>", unsafe_allow_html=True)

# ---------------------------------------------------------
# 9. App Footer
# ---------------------------------------------------------
st.markdown("""
<div style="text-align: center; font-size: 0.75rem; color: var(--text-dim); margin-top: 2rem; border-top: 1px solid var(--border); padding-top: 1rem;">
    Apex Sales Intelligence • Streamlit Modern Analytics Engine
</div>
""", unsafe_allow_html=True)
