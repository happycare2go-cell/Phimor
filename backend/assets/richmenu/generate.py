import cairosvg, os

OUT = "/home/claude/phimor/backend/assets/richmenu"
os.makedirs(OUT, exist_ok=True)
FT = "Loma"
NAVY = "#1C2B64"
GOLD = "#DEB14E"
WHITE = "#FFFFFF"
LIGHT = "#EEF1F8"

W, H = 2500, 1686

def btn(x, y, w, h, fill, label, icon_fn, sub=""):
    tc = NAVY if fill in (WHITE,LIGHT) else WHITE
    s = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>'
    cy = y + h/2 - (20 if sub else 0)
    s += icon_fn(x+w/2, cy-90, tc)
    s += f'<text x="{x+w/2}" y="{cy+130}" text-anchor="middle" font-family="{FT}" font-size="72" font-weight="bold" fill="{tc}">{label}</text>'
    if sub:
        s += f'<text x="{x+w/2}" y="{cy+195}" text-anchor="middle" font-family="{FT}" font-size="40" fill="{"#5A6580" if fill in (WHITE,LIGHT) else "#CADCFC"}">{sub}</text>'
    return s

# ── ไอคอนวาดเองด้วย SVG Shape ล้วน ไม่พึ่ง Emoji Font (กันปัญหา Glyph หาย) ──
def ic_people(cx, cy, c):  # จัดการผู้พัก — คนสองคน
    return (f'<circle cx="{cx-38}" cy="{cy-15}" r="26" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<path d="M {cx-78} {cy+55} Q {cx-78} {cy+5} {cx-38} {cy+5} Q {cx+2} {cy+5} {cx+2} {cy+55}" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<circle cx="{cx+38}" cy="{cy-5}" r="22" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<path d="M {cx+2} {cy+55} Q {cx+2} {cy+15} {cx+38} {cy+15} Q {cx+74} {cy+15} {cx+74} {cy+55}" fill="none" stroke="{c}" stroke-width="7"/>')
def ic_car(cx, cy, c):  # รอดำเนินการ — รถ
    return (f'<rect x="{cx-70}" y="{cy-10}" width="140" height="45" rx="14" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<path d="M {cx-48} {cy-10} L {cx-28} {cy-42} L {cx+28} {cy-42} L {cx+48} {cy-10}" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<circle cx="{cx-38}" cy="{cy+42}" r="14" fill="{c}"/><circle cx="{cx+38}" cy="{cy+42}" r="14" fill="{c}"/>')
def ic_chat(cx, cy, c):  # ติดต่อ — Speech Bubble
    return (f'<rect x="{cx-72}" y="{cy-45}" width="144" height="95" rx="20" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<path d="M {cx-25} {cy+50} L {cx-25} {cy+80} L {cx+15} {cy+50} Z" fill="{c}"/>'
            f'<line x1="{cx-40}" y1="{cy-10}" x2="{cx+40}" y2="{cy-10}" stroke="{c}" stroke-width="7"/>'
            f'<line x1="{cx-40}" y1="{cy+15}" x2="{cx+15}" y2="{cy+15}" stroke="{c}" stroke-width="7"/>')
def ic_home(cx, cy, c):  # หน้าหลัก — บ้าน
    return (f'<path d="M {cx-58} {cy+10} L {cx} {cy-48} L {cx+58} {cy+10}" fill="none" stroke="{c}" stroke-width="7" stroke-linejoin="round"/>'
            f'<rect x="{cx-38}" y="{cy+8}" width="76" height="58" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<rect x="{cx-14}" y="{cy+32}" width="28" height="34" fill="{c}"/>')
def ic_write(cx, cy, c):  # บันทึก — ปากกา
    return (f'<path d="M {cx-45} {cy+50} L {cx-52} {cy+75} L {cx-27} {cy+68} L {cx+45} {cy-4} L {cx+18} {cy-32} Z" fill="none" stroke="{c}" stroke-width="7" stroke-linejoin="round"/>'
            f'<line x1="{cx+6}" y1="{cy-20}" x2="{cx+33}" y2="{cy+8}" stroke="{c}" stroke-width="7"/>')
def ic_history(cx, cy, c):  # ประวัติ — เอกสาร
    return (f'<rect x="{cx-42}" y="{cy-48}" width="84" height="100" rx="8" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<line x1="{cx-24}" y1="{cy-18}" x2="{cx+24}" y2="{cy-18}" stroke="{c}" stroke-width="6"/>'
            f'<line x1="{cx-24}" y1="{cy+4}" x2="{cx+24}" y2="{cy+4}" stroke="{c}" stroke-width="6"/>'
            f'<line x1="{cx-24}" y1="{cy+26}" x2="{cx+8}" y2="{cy+26}" stroke="{c}" stroke-width="6"/>')

# ══ ชุดที่ 1: ฝั่งศูนย์ — 3 ปุ่มแนวนอน ══
b = f'<rect width="{W}" height="{H}" fill="{WHITE}"/>'
b += f'<line x1="{W/3}" y1="0" x2="{W/3}" y2="{H}" stroke="#D8DEEC" stroke-width="4"/>'
b += f'<line x1="{2*W/3}" y1="0" x2="{2*W/3}" y2="{H}" stroke="#D8DEEC" stroke-width="4"/>'
b += btn(0, 0, W/3, H, NAVY, "จัดการผู้พัก", ic_people)
b += btn(W/3, 0, W/3, H, GOLD, "รอดำเนินการ", ic_car)
b += btn(2*W/3, 0, W/3, H, LIGHT, "ติดต่อทีมงาน", ic_chat)
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{b}</svg>'
cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/center-admin.png", output_width=W, output_height=H)
print("✓ center-admin.png")

# ══ ชุดที่ 2: ฝั่งครอบครัว — 2x2 ══
b = f'<rect width="{W}" height="{H}" fill="{WHITE}"/>'
b += f'<line x1="{W/2}" y1="0" x2="{W/2}" y2="{H}" stroke="#D8DEEC" stroke-width="4"/>'
b += f'<line x1="0" y1="{H/2}" x2="{W}" y2="{H/2}" stroke="#D8DEEC" stroke-width="4"/>'
b += btn(0, 0, W/2, H/2, NAVY, "หน้าหลัก", ic_home)
b += btn(W/2, 0, W/2, H/2, GOLD, "บันทึกนัด/ยา", ic_write)
b += btn(0, H/2, W/2, H/2, LIGHT, "ดูประวัติ", ic_history)
b += btn(W/2, H/2, W/2, H/2, "#3A4E96", "ติดต่อ Admin", ic_chat)
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{b}</svg>'
cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/family.png", output_width=W, output_height=H)
print("✓ family.png")
