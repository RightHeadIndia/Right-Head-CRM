#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RecruitIQ comprehensive report generator.
Reads sample screening data matching the CRM's RecruitIQ model (lib/recruit-iq.js)
and produces a PDF report with location, experience, JD pointer match/mismatch,
education, strengths/weaknesses, and match-category visualisations.
"""
import os
import json
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, os.pardir)  # right-head-crm root
REPORT_PATH = os.path.join(OUT_DIR, "RecruitIQ_Screening_Report.pdf")

# Colour palette (one colour per entity, used consistently)
COLOURS = ["#1B2A33", "#2E86AB", "#A23B72", "#F18F01", "#C73E1D", "#6A994E", "#7A7A7A"]

JD_DIMENSIONS = [
    "Skills", "Relevant experience", "Industry experience",
    "Role and responsibilities", "Education", "Tools and certifications",
]

# ---------------------------------------------------------------------------
# Sample screening dataset matching the CRM RecruitIQ model
# ---------------------------------------------------------------------------
JOB_TITLE = "Senior Backend Engineer"

def build_sample_data():
    """Return a list of candidate records matching the CRM RecruitIQ shape."""
    return [
        {
            "id": "c1", "name": "Asha Sharma", "email": "asha@example.com",
            "location": "Bangalore", "status": "Shortlisted",
            "totalExperience": "5 years", "relevantExperience": "4 years",
            "education": "B.Tech Computer Science", "currentCompany": "TechFlow",
            "skills": ["Node.js", "React", "PostgreSQL", "AWS", "Docker"],
            "tools": ["Git", "Jira", "Figma"],
            "matchedSkills": ["Node.js", "React", "PostgreSQL"],
            "missingSkills": ["AWS", "Docker"],
            "dimensions": [
                {"name": "Skills", "score": 75, "weight": 30},
                {"name": "Relevant experience", "score": 85, "weight": 20},
                {"name": "Industry experience", "score": 70, "weight": 15},
                {"name": "Role and responsibilities", "score": 60, "weight": 20},
                {"name": "Education", "score": 90, "weight": 10},
                {"name": "Tools and certifications", "score": 50, "weight": 5},
            ],
            "strengths": ["Strong React and Node.js backend skills", "Good relevant experience"],
            "weaknesses": ["Limited AWS and Docker exposure", "No cloud certification"],
            "category": "Good Match", "total": 71,
        },
        {
            "id": "c2", "name": "Rohan Mehta", "email": "rohan@example.com",
            "location": "Mumbai", "status": "Hold",
            "totalExperience": "3 years", "relevantExperience": "2 years",
            "education": "M.Tech Data Science", "currentCompany": "DataPulse",
            "skills": ["Python", "SQL", "Pandas", "Scikit-learn"],
            "tools": ["Jupyter", "Git"],
            "matchedSkills": ["Python", "SQL"],
            "missingSkills": ["Node.js", "React", "AWS"],
            "dimensions": [
                {"name": "Skills", "score": 55, "weight": 30},
                {"name": "Relevant experience", "score": 60, "weight": 20},
                {"name": "Industry experience", "score": 40, "weight": 15},
                {"name": "Role and responsibilities", "score": 45, "weight": 20},
                {"name": "Education", "score": 95, "weight": 10},
                {"name": "Tools and certifications", "score": 30, "weight": 5},
            ],
            "strengths": ["Strong academic background in data science", "Python and SQL proficiency"],
            "weaknesses": ["Limited full-stack experience", "Missing core stack skills (Node.js, React)"],
            "category": "Moderate Match", "total": 55,
        },
        {
            "id": "c3", "name": "Priya Nair", "email": "priya@example.com",
            "location": "Bangalore", "status": "Interview Scheduled",
            "totalExperience": "7 years", "relevantExperience": "6 years",
            "education": "MBA + B.Com", "currentCompany": "FinCorp",
            "skills": ["Java", "Spring Boot", "SQL", "REST APIs"],
            "tools": ["Maven", "IntelliJ", "Postman"],
            "matchedSkills": ["Java", "Spring Boot", "SQL"],
            "missingSkills": ["React", "AWS", "Docker"],
            "dimensions": [
                {"name": "Skills", "score": 65, "weight": 30},
                {"name": "Relevant experience", "score": 80, "weight": 20},
                {"name": "Industry experience", "score": 85, "weight": 15},
                {"name": "Role and responsibilities", "score": 55, "weight": 20},
                {"name": "Education", "score": 70, "weight": 10},
                {"name": "Tools and certifications", "score": 40, "weight": 5},
            ],
            "strengths": ["Strong Java/Spring Boot backend", "Good industry experience"],
            "weaknesses": ["No frontend (React) experience", "Limited cloud/DevOps"],
            "category": "Moderate Match", "total": 65,
        },
        {
            "id": "c4", "name": "Kiran Reddy", "email": "kiran@example.com",
            "location": "Hyderabad", "status": "Rejected",
            "totalExperience": "2 years", "relevantExperience": "1 year",
            "education": "B.Sc IT", "currentCompany": "StartUpX",
            "skills": ["HTML", "CSS", "JavaScript"],
            "tools": ["VS Code"],
            "matchedSkills": ["JavaScript"],
            "missingSkills": ["Node.js", "React", "PostgreSQL", "AWS"],
            "dimensions": [
                {"name": "Skills", "score": 30, "weight": 30},
                {"name": "Relevant experience", "score": 40, "weight": 20},
                {"name": "Industry experience", "score": 25, "weight": 15},
                {"name": "Role and responsibilities", "score": 35, "weight": 20},
                {"name": "Education", "score": 60, "weight": 10},
                {"name": "Tools and certifications", "score": 20, "weight": 5},
            ],
            "strengths": ["Foundational web development knowledge"],
            "weaknesses": ["Limited relevant experience", "Missing most required stack skills"],
            "category": "Low Match", "total": 35,
        },
        {
            "id": "c5", "name": "Sneha Iyer", "email": "sneha@example.com",
            "location": "Chennai", "status": "Shortlisted",
            "totalExperience": "6 years", "relevantExperience": "5 years",
            "education": "M.C.A.", "currentCompany": "Cloud9",
            "skills": ["Node.js", "React", "AWS", "Docker", "Kubernetes"],
            "tools": ["Git", "Jenkins", "Terraform"],
            "matchedSkills": ["Node.js", "React", "AWS", "Docker"],
            "missingSkills": ["Kubernetes"],
            "dimensions": [
                {"name": "Skills", "score": 90, "weight": 30},
                {"name": "Relevant experience", "score": 85, "weight": 20},
                {"name": "Industry experience", "score": 80, "weight": 15},
                {"name": "Role and responsibilities", "score": 85, "weight": 20},
                {"name": "Education", "score": 85, "weight": 10},
                {"name": "Tools and certifications", "score": 90, "weight": 5},
            ],
            "strengths": ["Full modern stack (Node, React, AWS, Docker)", "DevOps tools (Jenkins, Terraform)"],
            "weaknesses": ["Kubernetes exposure still growing"],
            "category": "Excellent Match", "total": 86,
        },
        {
            "id": "c6", "name": "Vikram Singh", "email": "vikram@example.com",
            "location": "Delhi", "status": "Hold",
            "totalExperience": "8 years", "relevantExperience": "4 years",
            "education": "B.E. Mechanical", "currentCompany": "AutoTech",
            "skills": ["Python", "SQL", "Embedded C"],
            "tools": ["Git", "Jira"],
            "matchedSkills": ["Python", "SQL"],
            "missingSkills": ["Node.js", "React", "AWS"],
            "dimensions": [
                {"name": "Skills", "score": 45, "weight": 30},
                {"name": "Relevant experience", "score": 50, "weight": 20},
                {"name": "Industry experience", "score": 35, "weight": 15},
                {"name": "Role and responsibilities", "score": 40, "weight": 20},
                {"name": "Education", "score": 50, "weight": 10},
                {"name": "Tools and certifications", "score": 35, "weight": 5},
            ],
            "strengths": ["Long overall experience", "Python and SQL skills"],
            "weaknesses": ["Relevant experience below requirement", "Wrong industry background"],
            "category": "Low Match", "total": 45,
        },
        {
            "id": "c7", "name": "Ananya Das", "email": "ananya@example.com",
            "location": "Pune", "status": "Interviewed",
            "totalExperience": "4 years", "relevantExperience": "3 years",
            "education": "B.Tech IT", "currentCompany": "WebScale",
            "skills": ["React", "Node.js", "MongoDB", "AWS"],
            "tools": ["Git", "Docker"],
            "matchedSkills": ["React", "Node.js", "AWS"],
            "missingSkills": ["PostgreSQL", "Docker"],
            "dimensions": [
                {"name": "Skills", "score": 80, "weight": 30},
                {"name": "Relevant experience", "score": 70, "weight": 20},
                {"name": "Industry experience", "score": 75, "weight": 15},
                {"name": "Role and responsibilities", "score": 75, "weight": 20},
                {"name": "Education", "score": 80, "weight": 10},
                {"name": "Tools and certifications", "score": 60, "weight": 5},
            ],
            "strengths": ["Good MERN stack exposure", "AWS and Docker knowledge"],
            "weaknesses": ["PostgreSQL not yet used"],
            "category": "Good Match", "total": 75,
        },
        {
            "id": "c8", "name": "Arjun Patel", "email": "arjun@example.com",
            "location": "Ahmedabad", "status": "Shortlisted",
            "totalExperience": "5 years", "relevantExperience": "4 years",
            "education": "M.Tech CSE", "currentCompany": "DevOpsPro",
            "skills": ["Node.js", "React", "AWS", "Docker", "Kubernetes", "Terraform"],
            "tools": ["Git", "Jenkins", "Prometheus"],
            "matchedSkills": ["Node.js", "React", "AWS", "Docker", "Kubernetes"],
            "missingSkills": [],
            "dimensions": [
                {"name": "Skills", "score": 95, "weight": 30},
                {"name": "Relevant experience", "score": 80, "weight": 20},
                {"name": "Industry experience", "score": 70, "weight": 15},
                {"name": "Role and responsibilities", "score": 85, "weight": 20},
                {"name": "Education", "score": 90, "weight": 10},
                {"name": "Tools and certifications", "score": 95, "weight": 5},
            ],
            "strengths": ["Complete cloud-native stack", "Strong DevOps tooling"],
            "weaknesses": ["Relocation required from Ahmedabad"],
            "category": "Excellent Match", "total": 86,
        },
    ]

# ---------------------------------------------------------------------------
# Aggregations
# ---------------------------------------------------------------------------
def aggregate(candidates):
    loc = {}
    exp = {}
    edu = {}
    cat = {}
    matched_all = []
    missing_all = []
    strengths_all = []
    weaknesses_all = []
    dim_scores = {d: [] for d in JD_DIMENSIONS}
    for c in candidates:
        loc[c["location"]] = loc.get(c["location"], 0) + 1
        exp[c["totalExperience"]] = exp.get(c["totalExperience"], 0) + 1
        edu[c["education"]] = edu.get(c["education"], 0) + 1
        cat[c["category"]] = cat.get(c["category"], 0) + 1
        matched_all.extend(c["matchedSkills"])
        missing_all.extend(c["missingSkills"])
        strengths_all.extend(c["strengths"])
        weaknesses_all.extend(c["weaknesses"])
        for d in c["dimensions"]:
            dim_scores[d["name"]].append(d["score"])
    dim_avg = {d: round(sum(v) / len(v), 1) for d, v in dim_scores.items() if v}
    return {
        "location": loc, "experience": exp, "education": edu, "category": cat,
        "matchedSkills": matched_all, "missingSkills": missing_all,
        "strengths": strengths_all, "weaknesses": weaknesses_all,
        "dimensionAvg": dim_avg,
    }

# ---------------------------------------------------------------------------
# Charts (matplotlib, saved to the scripts folder)
# ---------------------------------------------------------------------------
def top_counts(counter, n=6):
    items = sorted(counter.items(), key=lambda x: x[1], reverse=True)
    return items[:n]

def make_pie(values, labels, title, fname, colors=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(5.2, 3.6), dpi=200)
    colors = colors or COLOURS[: len(values)]
    wedges, texts, autotexts = ax.pie(
        values, labels=labels, autopct="%1.0f%%", startangle=90,
        colors=colors, textprops={"fontsize": 8},
        wedgeprops={"edgecolor": "white", "linewidth": 1},
    )
    for at in autotexts:
        at.set_color("white"); at.set_fontsize(8); at.set_weight("bold")
    ax.set_title(title, fontsize=10, weight="bold", color=COLOURS[0])
    ax.axis("equal")
    path = os.path.join(HERE, fname)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path

def make_bar(values, labels, title, fname, xlabel="", colors=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(5.2, 3.4), dpi=200)
    colors = colors or COLOURS[: len(values)]
    bars = ax.bar(labels, values, color=colors, edgecolor="white", linewidth=0.5)
    ax.set_title(title, fontsize=10, weight="bold", color=COLOURS[0])
    ax.set_ylabel(xlabel, fontsize=8)
    ax.tick_params(axis="x", rotation=30, labelsize=7)
    ax.tick_params(axis="y", labelsize=7)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for b in bars:
        ax.annotate(f"{b.get_height()}", (b.get_x() + b.get_width() / 2, b.get_height()),
                    ha="center", va="bottom", fontsize=7)
    path = os.path.join(HERE, fname)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path

CHART_PATHS = []

def build_charts(agg):
    global CHART_PATHS
    CHART_PATHS = []
    # Location pie
    loc_items = top_counts(agg["location"], 6)
    CHART_PATHS.append(make_pie(
        [v for _, v in loc_items], [k for k, _ in loc_items],
        "Candidate Location", "chart_location.png"))
    # Experience pie
    exp_items = top_counts(agg["experience"], 6)
    CHART_PATHS.append(make_pie(
        [v for _, v in exp_items], [k for k, _ in exp_items],
        "Total Experience", "chart_experience.png"))
    # Education pie
    edu_items = top_counts(agg["education"], 6)
    CHART_PATHS.append(make_pie(
        [v for _, v in edu_items], [k for k, _ in edu_items],
        "Education Background", "chart_education.png"))
    # Match category pie
    cat_items = sorted(agg["category"].items(), key=lambda x: x[1], reverse=True)
    CHART_PATHS.append(make_pie(
        [v for _, v in cat_items], [k for k, _ in cat_items],
        "JD Match Category", "chart_category.png", colors=["#2E86AB", "#F18F01", "#A23B72", "#C73E1D"]))
    # Matched vs missing skills bar
    matched_items = top_counts(__import__("collections").Counter(agg["matchedSkills"]), 6)
    missing_items = top_counts(__import__("collections").Counter(agg["missingSkills"]), 6)
    labels = sorted(set([k for k, _ in matched_items] + [k for k, _ in missing_items]))
    m_vals = [dict(matched_items).get(l, 0) for l in labels]
    mi_vals = [dict(missing_items).get(l, 0) for l in labels]
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    fig, ax = plt.subplots(figsize=(6.4, 3.2), dpi=200)
    x = np.arange(len(labels)); w = 0.38
    ax.bar(x - w/2, m_vals, w, label="Matched", color=COLOURS[1])
    ax.bar(x + w/2, mi_vals, w, label="Missing", color=COLOURS[4])
    ax.set_title("JD Pointer Matches vs Mismatches", fontsize=10, weight="bold", color=COLOURS[0])
    ax.set_ylabel("Candidates", fontsize=8)
    ax.set_xticks(x); ax.set_xticklabels(labels, rotation=30, fontsize=7)
    ax.tick_params(axis="y", labelsize=7)
    ax.legend(fontsize=7)
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    path = os.path.join(HERE, "chart_skills.png")
    fig.tight_layout(); fig.savefig(path, bbox_inches="tight", facecolor="white"); plt.close(fig)
    CHART_PATHS.append(path)
    # Dimension average bar
    dims = list(agg["dimensionAvg"].keys())
    vals = list(agg["dimensionAvg"].values())
    CHART_PATHS.append(make_bar(
        vals, dims, "Average JD Dimension Score", "chart_dimensions.png", xlabel="Score / 100"))
    # Strengths vs weaknesses count
    CHART_PATHS.append(make_bar(
        [len(agg["strengths"]), len(agg["weaknesses"])],
        ["Strengths", "Weaknesses"],
        "Strengths vs Weaknesses Cited", "chart_strengths_weaknesses.png", xlabel="Count"))
    return CHART_PATHS

# ---------------------------------------------------------------------------
# PDF report (reportlab platypus)
# ---------------------------------------------------------------------------
def build_pdf(candidates, agg, charts):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_LEFT, TA_CENTER
    from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                    Spacer, Image, Table, TableStyle, PageBreak,
                                    KeepTogether, HRFlowable)

    PAGE_W, PAGE_H = A4
    M = 16 * mm

    NAVY = colors.HexColor(COLOURS[0])
    TEAL = colors.HexColor(COLOURS[1])
    LIGHT = colors.HexColor("#F4F6F8")
    GREY = colors.HexColor("#6B7280")

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="TitleMain", parent=styles["Title"],
                              fontSize=24, leading=28, textColor=NAVY, spaceAfter=4))
    styles.add(ParagraphStyle(name="TitleSub", parent=styles["Normal"],
                              fontSize=11, leading=15, textColor=GREY, spaceAfter=2))
    styles.add(ParagraphStyle(name="H1", parent=styles["Heading1"],
                              fontSize=15, leading=18, textColor=NAVY, spaceBefore=14, spaceAfter=6))
    styles.add(ParagraphStyle(name="H2", parent=styles["Heading2"],
                              fontSize=12, leading=15, textColor=TEAL, spaceBefore=10, spaceAfter=4))
    styles.add(ParagraphStyle(name="Body", parent=styles["Normal"],
                              fontSize=9, leading=12.5, textColor=colors.black, spaceAfter=4))
    styles.add(ParagraphStyle(name="Small", parent=styles["Normal"],
                              fontSize=7.5, leading=10, textColor=GREY, spaceAfter=2))
    styles.add(ParagraphStyle(name="Cell", parent=styles["Normal"],
                              fontSize=8, leading=10, textColor=colors.black))
    styles.add(ParagraphStyle(name="CellBold", parent=styles["Cell"],
                              fontSize=8, leading=10, textColor=NAVY, fontName="Helvetica-Bold"))

    story = []

    def header_footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(NAVY); canvas.setLineWidth(1.2)
        canvas.line(M, PAGE_H - 12 * mm, PAGE_W - M, PAGE_H - 12 * mm)
        canvas.setFont("Helvetica-Bold", 9); canvas.setFillColor(NAVY)
        canvas.drawString(M, PAGE_H - 10 * mm, "RecruitIQ — Candidate Screening Report")
        canvas.setFont("Helvetica", 8); canvas.setFillColor(GREY)
        canvas.drawRightString(PAGE_W - M, PAGE_H - 10 * mm,
                               f"Job: {JOB_TITLE}")
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(M, 8 * mm, "Generated from CRM RecruitIQ screening data — confidential, internal use only.")
        canvas.drawRightString(PAGE_W - M, 8 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = BaseDocTemplate(REPORT_PATH,
                          pagesize=A4, leftMargin=M, rightMargin=M,
                          topMargin=18 * mm, bottomMargin=14 * mm,
                          title="RecruitIQ Report", author="CRM RecruitIQ")
    frame = Frame(M, 14 * mm, PAGE_W - 2 * M, PAGE_H - 32 * mm, id="f")
    doc.addPageTemplates([PageTemplate(id="pt", frames=[frame], onPage=header_footer)])

    # Title block
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("RecruitIQ", styles["TitleMain"]))
    story.append(Paragraph("Candidate Screening & JD Match Report", ParagraphStyle(
        name="sub", parent=styles["TitleSub"], fontSize=13, textColor=TEAL, spaceAfter=8)))
    story.append(HRFlowable(width="100%", thickness=1, color=TEAL, spaceAfter=8))
    story.append(Paragraph(f"<b>Job:</b> {JOB_TITLE}", styles["Body"]))
    story.append(Paragraph(f"<b>Candidates screened:</b> {len(candidates)} &nbsp;|&nbsp; "
                           f"<b>Locations:</b> {len(agg['location'])} &nbsp;|&nbsp; "
                           f"<b>JD dimensions:</b> {len(JD_DIMENSIONS)}", styles["Body"]))
    story.append(Spacer(1, 4 * mm))

    # Summary KPI table
    avg_total = round(sum(c["total"] for c in candidates) / len(candidates), 1)
    excellent = agg["category"].get("Excellent Match", 0)
    good = agg["category"].get("Good Match", 0)
    mod = agg["category"].get("Moderate Match", 0)
    low = agg["category"].get("Low Match", 0)
    kpi = Table([
        [Paragraph("Candidates", styles["CellBold"]), Paragraph("Avg Match Score", styles["CellBold"]),
         Paragraph("Excellent", styles["CellBold"]), Paragraph("Good / Moderate / Low", styles["CellBold"])],
        [Paragraph(str(len(candidates)), styles["Cell"]), Paragraph(f"{avg_total}/100", styles["Cell"]),
         Paragraph(str(excellent), styles["Cell"]),
         Paragraph(f"{good} / {mod} / {low}", styles["Cell"])],
    ], colWidths=[(PAGE_W - 2 * M) / 4] * 4)
    kpi.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("BACKGROUND", (0, 1), (-1, 1), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(kpi)
    story.append(Spacer(1, 4 * mm))

    # Location + Experience pies side by side
    row = Table([[Image(charts[0], width=62 * mm, height=42 * mm),
                  Image(charts[1], width=62 * mm, height=42 * mm)]],
                colWidths=[(PAGE_W - 2 * M) / 2, (PAGE_W - 2 * M) / 2])
    row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "CENTER"),
                             ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    story.append(row)
    story.append(Paragraph("Pie charts show where candidates are based and their years of total experience.", styles["Small"]))
    story.append(Spacer(1, 3 * mm))

    # Education + Category pies side by side
    row2 = Table([[Image(charts[2], width=62 * mm, height=42 * mm),
                   Image(charts[3], width=62 * mm, height=42 * mm)]],
                 colWidths=[(PAGE_W - 2 * M) / 2, (PAGE_W - 2 * M) / 2])
    row2.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "CENTER"),
                              ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    story.append(row2)
    story.append(Paragraph("Education backgrounds and the JD match category assigned per candidate.", styles["Small"]))
    story.append(PageBreak())

    # Matches vs mismatches
    story.append(Paragraph("JD Pointer Matches vs Mismatches", styles["H1"]))
    story.append(Image(charts[4], width=110 * mm, height=55 * mm))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(
        "The bar chart compares how often each required JD skill pointer appears as matched versus missing across all screened candidates. "
        "Skills appearing more often in the Missing column are common gaps to address in hiring or upskilling plans.", styles["Body"]))

    # Dimension averages
    story.append(Paragraph("Average Score by JD Dimension", styles["H1"]))
    story.append(Image(charts[5], width=110 * mm, height=58 * mm))
    story.append(Spacer(1, 3 * mm))
    dim_rows = [[Paragraph("Dimension", styles["CellBold"]), Paragraph("Avg Score", styles["CellBold"])]]
    for d, v in sorted(agg["dimensionAvg"].items(), key=lambda x: x[1], reverse=True):
        dim_rows.append([Paragraph(d, styles["Cell"]), Paragraph(f"{v}/100", styles["Cell"])])
    dim_t = Table(dim_rows, colWidths=[(PAGE_W - 2 * M) * 0.6, (PAGE_W - 2 * M) * 0.4])
    dim_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(dim_t)
    story.append(Spacer(1, 4 * mm))

    # Strengths vs weaknesses
    story.append(Paragraph("Strengths vs Weaknesses", styles["H1"]))
    story.append(Image(charts[6], width=70 * mm, height=37 * mm))
    story.append(Spacer(1, 4 * mm))
    story.append(PageBreak())

    # Candidate detail table
    story.append(Paragraph("Candidate Details", styles["H1"]))
    detail = [[Paragraph(h, styles["CellBold"]) for h in
               ["#", "Name", "Location", "Experience", "Education", "Category", "Score"]]]
    for i, c in enumerate(candidates, 1):
        detail.append([Paragraph(str(i), styles["Cell"]), Paragraph(c["name"], styles["Cell"]),
                       Paragraph(c["location"], styles["Cell"]), Paragraph(c["totalExperience"], styles["Cell"]),
                       Paragraph(c["education"], styles["Cell"]), Paragraph(c["category"], styles["Cell"]),
                       Paragraph(str(c["total"]), styles["Cell"])])
    det_t = Table(detail, colWidths=[8 * mm, 30 * mm, 24 * mm, 22 * mm, 30 * mm, 26 * mm, 14 * mm],
                  repeatRows=1)
    det_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FBFC")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(det_t)
    story.append(Spacer(1, 5 * mm))

    # Per-candidate matched/missing skills and strengths/weaknesses
    story.append(Paragraph("Matched Skills, Missing Skills, Strengths & Weaknesses", styles["H1"]))
    for c in candidates:
        block = [
            Paragraph(f"{c['name']} — {c['category']} ({c['total']}/100)", styles["CellBold"]),
            Paragraph(f"<b>Matched:</b> {', '.join(c['matchedSkills']) or '—'}", styles["Cell"]),
            Paragraph(f"<b>Missing:</b> {', '.join(c['missingSkills']) or '—'}", styles["Cell"]),
            Paragraph(f"<b>Strengths:</b> {'; '.join(c['strengths']) or '—'}", styles["Cell"]),
            Paragraph(f"<b>Weaknesses:</b> {'; '.join(c['weaknesses']) or '—'}", styles["Cell"]),
            Spacer(1, 2 * mm),
        ]
        story.append(KeepTogether(block))
    story.append(Spacer(1, 4 * mm))

    # Dimension detail per candidate
    story.append(Paragraph("JD Dimension Scores per Candidate", styles["H1"]))
    dim_header = ["Name"] + JD_DIMENSIONS + ["Total"]
    dim_rows = [[Paragraph(h, styles["CellBold"]) for h in dim_header]]
    for c in candidates:
        row_vals = [Paragraph(c["name"], styles["Cell"])]
        for d in JD_DIMENSIONS:
            score = next((x["score"] for x in c["dimensions"] if x["name"] == d), 0)
            row_vals.append(Paragraph(str(score), styles["Cell"]))
        row_vals.append(Paragraph(str(c["total"]), styles["CellBold"]))
        dim_rows.append(row_vals)
    dim_t2 = Table(dim_rows, colWidths=[28 * mm] + [14 * mm] * len(JD_DIMENSIONS) + [14 * mm],
                   repeatRows=1)
    dim_t2.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FBFC")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(dim_t2)
    story.append(Spacer(1, 6 * mm))

    # Footer note
    story.append(HRFlowable(width="100%", thickness=0.8, color=GREY, spaceAfter=4))
    story.append(Paragraph(
        "Note: This report is generated from sample CRM RecruitIQ screening data matching the system's data model. "
        "Scores reflect weighted JD dimension ratings as computed by the RecruitIQ matching module.", styles["Small"]))

    doc.build(story)
    return REPORT_PATH

def main():
    candidates = build_sample_data()
    agg = aggregate(candidates)
    charts = build_charts(agg)
    pdf = build_pdf(candidates, agg, charts)
    print("Report written to:", pdf)

if __name__ == "__main__":
    main()

