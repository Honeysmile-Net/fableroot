# Fableroot · เกมบน Cloudflare Pages + บันทึกออนไลน์ด้วยบัญชี Google

```
public/              ตัวเกม (index.html, img/, audio/)
functions/api/       API ฝั่งเซิร์ฟเวอร์ (Cloudflare Pages Functions)
schema.sql           ตารางฐานข้อมูล D1 (รันครั้งเดียว)
```

## ตั้งค่าครั้งแรก

### 1. Google: สร้าง Client ID
1. เข้า https://console.cloud.google.com → สร้างโปรเจกต์ใหม่ ชื่ออะไรก็ได้ เช่น `Fableroot`
2. เมนู **APIs & Services → OAuth consent screen** → เลือก **External** → ใส่ชื่อแอป `Fableroot` กับอีเมลของคุณ → บันทึก → กด **Publish app** (ให้คนนอกล็อกอินได้)
3. เมนู **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://fableroot.pages.dev` (ใช้ชื่อโปรเจกต์ Cloudflare ของคุณ ถ้ามีโดเมนเองให้ใส่เพิ่ม)
   - ไม่ต้องใส่ Redirect URI
4. คัดลอก **Client ID** (ลงท้ายด้วย `.apps.googleusercontent.com`)

### 2. Cloudflare: ฐานข้อมูล D1
1. dash.cloudflare.com → **Storage & Databases → D1 → Create** → ชื่อ `fableroot`
2. เปิดฐานข้อมูล → แท็บ **Console** → วางข้อความทั้งหมดใน `schema.sql` → **Execute**

### 3. Cloudflare: Pages ต่อกับ GitHub
1. **Workers & Pages → Create → Pages → Connect to Git** → เลือก repo นี้
2. Project name: `fableroot` · Framework preset: **None** · Build command: (เว้นว่าง) · Build output directory: `public`
3. **Save and Deploy**
4. เข้าโปรเจกต์ → **Settings → Bindings → Add → D1 database** → Variable name `DB` → เลือก `fableroot`
5. **Settings → Variables and Secrets → Add** → `GOOGLE_CLIENT_ID` = Client ID จากข้อ 1
6. **Deployments → (deployment ล่าสุด) → Retry deployment** ให้ค่าที่ตั้งมีผล

ต่อจากนี้ทุกครั้งที่มีโค้ดใหม่ใน repo Cloudflare จะ deploy ให้เอง

## ระบบทำงานอย่างไร
- ผู้เล่นกด "เข้าสู่ระบบด้วย Google" → เซิร์ฟเวอร์ตรวจลายเซ็นของ Google แล้วออกคุกกี้ session 30 วัน (HttpOnly)
- เกมยังเซฟลงเครื่องทุก 20 วิ และส่งขึ้นเซิร์ฟเวอร์ทุก 60 วิ กับตอนปิด/สลับแอป
- เปิดเกมหรือกลับหน้าแรก → ดึงเซฟจากเซิร์ฟเวอร์ ช่องไหนใหม่กว่าใช้อันนั้น
- เล่นช่องเดียวกันสองเครื่อง: เครื่องที่เริ่มบันทึกทีหลังยึดช่องนั้น เครื่องเก่าจะขึ้นเตือนและหยุดส่ง
- เล่นโดยไม่ล็อกอินได้ (เซฟเฉพาะเครื่อง) ล็อกอินครั้งแรกจะย้ายเซฟในเครื่องขึ้นบัญชีให้
- โควตาฟรีของ D1: เขียน 100,000 ครั้ง/วัน ≈ ผู้เล่นออนไลน์รวมกันราว 1,600 ชั่วโมง/วัน
