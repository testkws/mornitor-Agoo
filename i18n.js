(() => {
  "use strict";

  // Thai is the source language: t("ข้อความไทย") returns it as-is in Thai mode and the
  // English entry below in English mode. Text with {name} placeholders takes params.
  const EN = {
    // Status and event labels
    "พบสถานที่": "Found", "พบสถานที่ (ไม่มีเบอร์โทร)": "Found (no phone)", "ไม่พบสถานที่": "Not found",
    "ผลลัพธ์ไม่ชัดเจน": "Ambiguous", "ข้อผิดพลาดในการค้นหา": "Lookup error",
    "รอดำเนินการ": "Pending", "กำลังทำงาน": "Running", "รอลองอีกครั้ง": "Waiting to retry", "ตรวจแล้ว": "Checked",
    "ครบจำนวนครั้งแล้ว": "Attempts exhausted", "ข้ามแล้ว": "Skipped", "ถูกบล็อก": "Blocked", "ล้มเหลว": "Failed",
    "หยุดชั่วคราว": "Paused", "ไม่มีงานที่ถึงกำหนด": "No work due", "ถูกขัดจังหวะ": "Interrupted",
    "ข้อมูลวินิจฉัย": "Debug", "ข้อมูล": "Info", "คำเตือน": "Warning", "ข้อผิดพลาด": "Error",
    "ต้องตรวจทาน": "Needs review",
    "นำเข้าภาพสถานะ": "Imported snapshot", "เริ่มการทำงาน": "Run started", "สัญญาณชีพ": "Heartbeat",
    "เริ่มค้นหา": "Lookup started", "ค้นหาเสร็จแล้ว": "Lookup completed", "ลองค้นหาอีกครั้ง": "Lookup retry",
    "สิ้นสุดการทำงาน": "Run ended", "กลับมาทำงานต่อ": "Queue resumed", "หยุดคิวชั่วคราว": "Queue paused",

    // Static page text (index.html)
    "มอนิเตอร์ Scraper": "Scraper Monitor",
    "ข้ามไปยังเนื้อหาแดชบอร์ด": "Skip to dashboard content",

    "รีเฟรชอัตโนมัติทุก 5 นาที": "Auto-refreshes every 5 minutes",
    "กำลังเชื่อมต่อ…": "Connecting…",
    "เวิร์กเกอร์": "Worker",
    "รีเฟรชตอนนี้": "Refresh now",
    "เปลี่ยนเป็นธีมมืด": "Switch to dark theme", "เปลี่ยนเป็นธีมสว่าง": "Switch to light theme",
    "ส่วนต่าง ๆ ของแดชบอร์ด": "Dashboard sections",
    "ภาพรวม": "Overview", "สถานที่": "Places", "บันทึกเหตุการณ์": "Logs",
    "ตัวกรองแดชบอร์ด": "Dashboard filters", "ช่วงวันที่": "Date range",
    "ช่วงก่อนหน้า": "Previous period", "ช่วงถัดไป": "Next period",
    "ช่วงเวลา": "Period", "24 ชั่วโมง": "24 hours", "7 วัน": "7 days", "30 วัน": "30 days",
    "รีเฟรชอัตโนมัติ": "Auto refresh", "5 นาที": "5 min",
    "ข้อมูลบางส่วนอาจไม่เป็นปัจจุบัน กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง": "Some displayed information may be out of date. Use Refresh now to retry.",
    "กำลังโหลดภาพรวม…": "Loading overview…",
    "หลักฐานที่รวบรวมได้ แยกตามสถานที่ใน OSM": "Collected evidence by OSM place.",
    "ส่งออกข้อมูลมอนิเตอร์เป็น CSV": "Export monitoring CSV",
    "ส่งออกทุกหน้าตามเวิร์กเกอร์และตัวกรองที่ใช้แล้ว เป็นข้อมูลมอนิเตอร์ดิบที่อาจมีรายการรอตรวจทาน": "Exports all pages for the selected worker and applied filters. Raw monitoring data may include items awaiting review.",
    "ตัวกรองสถานที่": "Place filters",
    "ค้นหา": "Search", "ชื่อหรือ OSM ID": "Name or OSM ID",
    "ผลลัพธ์": "Outcome", "ผลลัพธ์ทั้งหมด": "All outcomes",
    "สถานะคิว": "Queue status", "สถานะทั้งหมด": "All statuses",
    "การตรวจทาน": "Review", "ทั้งหมด": "All", "ไม่มีเครื่องหมายให้ตรวจทาน": "No review flag",
    "ล้างตัวกรอง": "Reset filters", "ใช้ตัวกรอง": "Apply filters",
    "กดใช้ตัวกรองเพื่ออัปเดตผลลัพธ์ การเลือกเวิร์กเกอร์มีผลกับทุกส่วน": "Apply changes to update results. The worker selection applies across sections.",
    "เวลาในการตรวจสอบแต่ละสถานที่": "Inspection time by place",
    "การลองตรวจสอบครั้งล่าสุดในหน้านี้ นับตั้งแต่เวิร์กเกอร์เริ่มจนเสร็จ ไม่นับเวลารอในคิว": "Latest recorded attempt on this page, from worker start to completion. Queue time is excluded.",
    "กำลังโหลดเวลาตรวจสอบ…": "Loading inspection times…",
    "กำลังโหลดสถานที่…": "Loading places…",
    "หน้ารายการสถานที่": "Places pages",
    "ก่อนหน้า": "Previous", "ถัดไป": "Next",
    "เหตุการณ์จากเวิร์กเกอร์ พร้อมเวลาที่เซิร์ฟเวอร์ได้รับ": "Worker events with server receipt times.",
    "ตัวกรองบันทึกเหตุการณ์": "Log filters",
    "ระดับความรุนแรง": "Severity", "ทุกระดับ": "All severities",
    "ตั้งแต่": "From", "ถึง": "To",
    "วันที่ใช้เวลาท้องถิ่นของคุณ กดใช้ตัวกรองเพื่ออัปเดตผลลัพธ์ การเลือกเวิร์กเกอร์มีผลกับทุกส่วนทันที": "Dates use your local time. Apply changes to update results; the worker selection updates all sections immediately.",
    "กำลังโหลดบันทึกเหตุการณ์…": "Loading logs…",
    "หน้าบันทึกเหตุการณ์": "Log pages",
    "หลักฐานสถานที่": "Place evidence", "ปิด": "Close",
    "ลองโหลดรายละเอียดอีกครั้ง": "Retry loading details",
    "ประวัติการลองตรวจสอบ": "Attempt history",
    "ระยะเวลานับตั้งแต่เวิร์กเกอร์เริ่มจนจบการลองตรวจสอบ ไม่นับเวลารอในคิว": "Duration runs from the worker starting to completing an attempt; queue time is excluded.",
    "หน้าประวัติการลองตรวจสอบ": "Attempt history pages",

    // Dynamic text (app.js)
    "{n} นาที": "{n} min", "{n} วินาที": "{n} s", "0 วินาที": "0 s", "น้อยกว่า 0.1 วินาที": "<0.1 s",
    "ข้อมูลบางส่วนอาจไม่เป็นปัจจุบัน": "Some displayed information may be out of date.",
    "อัปเดตล่าสุด {time}": "Last updated {time}.",
    "กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง": "Use Refresh now to retry.",
    "อัปเดตไม่สำเร็จ": "Update failed", "อัปเดตแล้ว {time}": "Updated {time}", "อัปเดตบางส่วน": "Partial update",
    "กำลังอัปเดต…": "Updating…",
    "ไม่พบรายการ": "No records found.",
    "เลื่อนด้านข้างเพื่อดูคอลัมน์ทั้งหมด": "Scroll sideways to see all columns.",
    "หน้า {page} จาก {pages} · {n} รายการ": "Page {page} of {pages} · {n} rows",
    "เวิร์กเกอร์ทั้งหมด": "All workers",
    "ไม่มีข้อมูลจำนวนครั้ง": "Count unavailable",
    "ไม่มีการลองตรวจสอบที่เสร็จแล้ว": "No completed attempts",
    "{a} จาก {b} ครั้ง": "{a} of {b} attempts",
    "จับคู่ได้": "Matched",
    "ภาพรวมคิว": "Queue snapshot",
    "ภาพสถานะล่าสุดที่อัปโหลด ไม่ขึ้นกับช่วงวันที่": "Latest uploaded snapshot, whatever the date range",
    "ที่อัตราของช่วงนี้ (ประมาณ {pace} ครั้งต่อวัน) รายการที่รอดำเนินการใช้เวลาอีกราว {days} วัน": ({ pace, days }) =>
      `At this period's pace (about ${pace} attempts a day), pending places need roughly ${days} more ${days === "1" ? "day" : "days"}.`,

    // Overview cards and charts
    "ตัวชี้วัดหลัก": "Key metrics",
    "เทียบกับช่วงก่อนหน้า": "vs previous period",
    "เทียบกับ 24 ชั่วโมงก่อนหน้า": "vs previous 24 hours", "เทียบกับ {n} วันก่อนหน้า": "vs previous {n} days",
    "การลองตรวจสอบที่เสร็จแล้ว": "Completed attempts", "เวลาตรวจสอบเฉลี่ย": "Average inspection time",
    "จับคู่ได้ {n} ครั้ง": "{n} matched", "{n} จุด": "{n} pts",
    "{n} ครั้ง": ({ n }) => `${n} ${n === "1" ? "attempt" : "attempts"}`,
    "จาก {n} ครั้งที่มีการบันทึกเวลา": ({ n }) => `Across ${n} timed ${n === "1" ? "attempt" : "attempts"}`,
    "ยังไม่มีการบันทึกเวลา": "No timed attempts yet",
    "กิจกรรมตามช่วงเวลา": "Activity over time", "ตัวชี้วัดในกราฟ": "Chart metric",
    "แสดงช่วงก่อนหน้า": "Show previous period", "ช่วงนี้": "This period",
    "{metric} · {range} ใช้ปุ่มลูกศรซ้ายขวาเพื่ออ่านค่าแต่ละช่วง": "{metric} · {range}. Use the left and right arrow keys to read each point.",
    "ดูเป็นตาราง": "Show as table", "ตาราง{name}": "{name} table",
    "ไม่มีข้อมูลกิจกรรม ระบบจะลองใหม่อัตโนมัติ": "Activity data is unavailable. Retrying automatically.",
    "ช่วงเวลาที่ทำงานมากที่สุด": "Busiest times",
    "การลองตรวจสอบที่เสร็จแล้ว แยกตามวันและชั่วโมง · เวลาท้องถิ่นของเบราว์เซอร์": "Completed attempts by weekday and hour · browser local time",
    "จำนวนการลองตรวจสอบที่เสร็จแล้ว แยกตามวันในสัปดาห์และชั่วโมง": "Completed attempts by weekday and hour",
    "{day} {hour}:00 · {n} ครั้ง": ({ day, hour, n }) => `${day} ${hour}:00 · ${n} ${n === "1" ? "attempt" : "attempts"}`,
    "ไม่มีการลองตรวจสอบที่เสร็จแล้วในช่วงนี้": "No completed attempts in this period.",
    "เวลาตรวจสอบ": "Inspection time", "เวลาเฉลี่ย": "Average",
    "ตั้งแต่เวิร์กเกอร์เริ่มจนเสร็จ ไม่นับเวลารอในคิว": "From worker start to completion. Queue time is excluded.",
    "ยังไม่มีการบันทึกเวลาในช่วงนี้": "No timed attempts in this period.",
    "ต่ำกว่า 10 วินาที": "Under 10 s", "10–20 วินาที": "10–20 s", "20–30 วินาที": "20–30 s",
    "30–60 วินาที": "30–60 s", "1 นาทีขึ้นไป": "1 min or more",
    "ข้อผิดพลาดและการบล็อก": "Errors and blocks",
    "รหัสข้อผิดพลาดที่พบบ่อย": "Most frequent error codes", "ไม่มีรหัสข้อผิดพลาดในช่วงนี้": "No error codes in this period.",
    "ความครอบคลุมของสถานที่": "Place coverage",
    "ผลลัพธ์ล่าสุดของแต่ละสถานที่ ไม่ขึ้นกับช่วงวันที่": "Latest result for each place, whatever the date range",
    "ยังไม่มีผลลัพธ์": "No result yet", "{a} จาก {b} สถานที่มีผลลัพธ์แล้ว": "{a} of {b} places have a result",
    "ตัวชี้วัดและกราฟคำนวณจากการลองตรวจสอบที่เสร็จแล้วในช่วงวันที่ที่เลือก ตามเวลาท้องถิ่นของเบราว์เซอร์ ส่วนคิว ความครอบคลุม และเวิร์กเกอร์อ้างอิงภาพสถานะที่อัปโหลดล่าสุด": "Metrics and charts use attempts completed in the selected date range, in the browser's local time. Queue, coverage and worker status reflect the latest uploaded snapshots.",

    "กำหนดไว้": "Scheduled",

    "ไม่มีข้อมูลเวิร์กเกอร์": "Worker data is unavailable.",

    "อัตราความสำเร็จ": "Success rate",

    "CAPTCHA / การบล็อก": "CAPTCHA / blocks",

    "ต้องขอความยินยอม {n} ครั้ง": "{n} consent required",
    "อัตราการลองซ้ำ": "Retry rate",

    "{pending} รอดำเนินการ · {scheduled} กำหนดไว้": "{pending} pending · {scheduled} scheduled",
    "{n} กำลังทำงาน · รวมการตรวจซ้ำในอนาคต": "{n} running · includes future rechecks",

    "ได้รับสัญญาณชีพล่าสุด": "Recent heartbeats received",
    "ยังไม่มีเวิร์กเกอร์": "No workers provisioned",
    "{a} ไม่มีสัญญาณชีพล่าสุด · {b} รายงานว่าหยุดทำงานล่าสุด": "{a} without a recent heartbeat · {b} last reported paused",
    "กำลังรอข้อมูลเวิร์กเกอร์": "Waiting for worker data",

    "สัญญาณชีพที่ได้รับภายใน 10 นาทีล่าสุด": "Heartbeat received within the last 10 minutes",
    "ยังไม่มีการตั้งค่าเวิร์กเกอร์ Scraper": "No scraper worker is provisioned yet.",
    "เวิร์กเกอร์ไม่รายงานสถานะ": "Worker not reporting",
    "รหัสเวิร์กเกอร์ {id}": "Worker ID {id}",
    "รายงานว่าหยุดทำงานล่าสุด: {reason}": "Last reported paused: {reason}",
    "กลับมาทำงานต่อแล้ว": "Queue resumed",
    "รอบทำงานสิ้นสุดแล้ว": "Runner stopped",
    "วันที่ตามเวลาไทย {day}": "Bangkok day {day}",
    "ยังไม่มีรายงานการใช้งาน": "No usage reported yet",
    "สถานที่ไม่มีชื่อ": "Unnamed place",
    "ยังไม่มีรายงานการค้นหา": "No lookup reported",
    "รายงานการสิ้นสุด": "exit reported",
    "ยังไม่มีรายงานการสิ้นสุดรอบทำงาน": "No run exit reported yet",
    "ยังไม่มีรายงานจำนวนในคิว": "No queue counts reported yet",
    "การใช้งานรายวัน / ขีดจำกัด": "Daily usage / limit",
    "การค้นหาที่รายงานล่าสุด": "Last reported lookup",
    "รออัปโหลด: {n}": "Pending uploads: {n}",
    "สัญญาณชีพล่าสุด": "Last heartbeat",
    "ได้รับภายใน 10 นาที": "Received within 10 minutes",
    "ไม่ได้รับสัญญาณชีพล่าสุด": "No recent heartbeat received",
    "อัปโหลดล่าสุด": "Last upload",
    "พบล่าสุด {date}": "Last seen {date}",
    "{a} / {b} ครั้งล่าสุด · เกิดต่อเนื่อง {c} ครั้ง": "{a} / {b} recent attempts · {c} consecutive",
    "ยังไม่มีรายงาน": "Not reported yet",
    "คิว: {value}": "Queue: {value}",
    "รายงานการสิ้นสุดล่าสุด: {value}": "Last reported exit: {value}",
    "ข้อผิดพลาดชั่วคราว: {value}": "Temporary errors: {value}",

    "กรุณาระบุวันที่เริ่มต้นและวันที่สิ้นสุดให้ถูกต้อง": "Enter valid start and end dates.",
    "วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด": "From must be on or before To.",
    "ยังไม่มีเวลาตรวจสอบที่เสร็จแล้วสำหรับสถานที่เหล่านี้": "No completed inspection times are available for these places yet.",
    "ไม่มีสถานที่ให้เปรียบเทียบในหน้านี้": "No places to compare on this page.",
    "เวลาตรวจสอบ เรียงจากนานที่สุด": "Inspection times, longest first",
    "(ไม่มีชื่อ)": "(unnamed)",
    "{d} จาก {p} สถานที่ มีการบันทึกเวลา เรียงจากนานที่สุด{missing}": ({ d, p, dn, pn, missing }) =>
      `${d} of ${p} ${pn === 1 ? "place" : "places"} ${dn === 1 ? "has" : "have"} a recorded time. Longest first.${missing}`,
    " · ไม่มีข้อมูล {m} แห่ง": " {m} unavailable.",
    " · เลื่อนเพื่อดูทั้งหมด": " Scroll to see all.",
    "โหลดเวลาตรวจสอบไม่สำเร็จ": "Unable to load inspection times.",
    "ลองโหลดกราฟอีกครั้ง": "Retry chart",
    "กราฟเวลาตรวจสอบไม่พร้อมใช้งาน ระบบจะลองใหม่อัตโนมัติ": "Inspection time chart is unavailable. Retrying automatically.",
    "กำลังรวบรวมข้อมูล {n} จาก {total} รายการ…": "Collecting {n} of {total} rows…",
    "ไม่พบข้อมูลที่ตรงกับตัวกรองที่ใช้แล้ว จึงไม่มีไฟล์ให้ดาวน์โหลด": "No rows match the applied filters; no file was downloaded.",
    "ดาวน์โหลดข้อมูลมอนิเตอร์ {n} รายการแล้ว": "Downloaded {n} monitoring rows.",
    "ส่งออกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง": "Export failed. Please try again.",
    "ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองอีกครั้ง": "The results changed during export. Please try again.",
    "ตัวเลขบางรายการมีขนาดเกินความแม่นยำของเบราว์เซอร์ โปรดส่งออกจากฐานข้อมูลโดยตรง": "A number exceeds browser precision. Export directly from the database instead.",
    "ไม่พบสถานที่ที่ตรงกับตัวกรองปัจจุบัน ลองปรับตัวกรองหรือเลือกเวิร์กเกอร์อื่น": "No places match the current filters. Adjust the filters or worker selection and try again.",
    "ยังไม่มีรายงานสถานที่": "No places have been reported yet.",
    "ชื่อ": "Name", "คิว": "Queue", "ตรวจทาน": "Review", "ข้อผิดพลาดล่าสุด": "Latest error",
    "ตารางสถานที่": "Places table",
    "กำลังโหลดรายละเอียดสถานที่…": "Loading place details…",
    "กำลังโหลด…": "Loading…",
    "ไม่พบรายละเอียดสถานที่นี้แล้ว": "Place details are no longer available.",
    "ข้อมูลต้นทาง OSM": "OSM source fields",
    "รายการที่ใกล้ที่สุดที่แนะนำ — รอตรวจทาน": "Suggested nearest match — awaiting review",
    "รายการ Google ที่ใกล้ที่สุดและตรวจทานแล้ว": "Reviewed nearest Google match",
    "ข้อเสนอ Google ที่สำเร็จล่าสุด": "Latest successful Google proposal",
    "รายการแนะนำนี้จะไม่ถูกรวมในการส่งออกผลลัพธ์ปกติจนกว่าจะอนุมัติบนเซิร์ฟเวอร์ Scraper แต่จะอยู่ในข้อมูลมอนิเตอร์ดิบ ใช้รายการตรวจทานเพื่อค้นหา ID": "This suggestion is excluded from normal scraper exports until approved on the scraper server, but it is included in raw monitoring data. Use review list to find its ID.",
    "ตัวเลือกที่ตรงกันล่าสุด": "Latest candidates",
    "วิธีจับคู่: {method} · ความคล้ายคลึง: {similarity} · ระยะทาง: {distance} ม. · เครื่องหมายตรวจทาน: {flag}": "Matching: {method} · Similarity: {similarity} · Distance: {distance} m · Review flag: {flag}",
    "มี": "Yes", "ไม่มี": "No",
    "ข้อผิดพลาดล่าสุด {code}": "Latest error {code}",
    "เสร็จเมื่อ": "Completed", "ระยะเวลา": "Duration", "สถานะ": "Status", "การจับคู่": "Match", "หลักฐาน": "Evidence",
    "ตารางประวัติการลองตรวจสอบ": "Attempt history table",
    "ยังไม่มีรายงานการลองตรวจสอบสำหรับสถานที่นี้": "No attempts have been reported for this place yet.",
    "โหลดรายละเอียดสถานที่ไม่สำเร็จ": "Unable to load place details.",
    "โหลดรายละเอียดสถานที่ไม่สำเร็จ กรุณาลองอีกครั้ง": "Unable to load place details. Try again.",
    "ไม่พร้อมใช้งาน": "Unavailable",
    "ดูรายละเอียด": "View",
    "กำลังโหลดรายละเอียด…": "Loading details…",
    "โหลดรายละเอียดไม่สำเร็จ": "Unable to load details.",
    "ดูหลักฐานของการลองตรวจสอบที่เสร็จเมื่อ {date}": "View evidence for attempt completed {date}",
    "ไม่พบหลักฐานการลองตรวจสอบนี้แล้ว": "Attempt evidence is no longer available.",
    "ไม่พบเหตุการณ์ที่ตรงกับตัวกรองปัจจุบัน ลองปรับตัวกรองหรือเลือกเวิร์กเกอร์อื่น": "No events match the current filters. Adjust the filters or worker selection and try again.",
    "ยังไม่ได้รับเหตุการณ์การทำงาน": "No operational events have been received yet.",
    "เวลาที่ได้รับ": "Received", "ระดับ": "Severity", "เหตุการณ์": "Event", "รอบทำงาน": "Run", "รายละเอียด": "Details",
    "ตารางบันทึกเหตุการณ์": "Operational logs table",
    "ดูรายละเอียด {event} ที่ได้รับเมื่อ {date}": "View details for {event} received {date}",
    "ไม่พบรายละเอียดบันทึกเหตุการณ์นี้แล้ว": "Log details are no longer available.",
    "กำลังโหลด{name}…": "Loading {name}…",
    "โหลด{name}ไม่สำเร็จ กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง": "Unable to load {name}. Select Refresh now to try again.",
    "โหลดข้อมูลมอนิเตอร์ไม่สำเร็จ": "Unable to load monitoring data.",
    "รีเฟรชข้อมูลไม่สำเร็จ": "Unable to refresh data.",
    "กำลังรีเฟรชแดชบอร์ด…": "Refreshing dashboard…",
    "อัปเดตแดชบอร์ดแล้ว": "Dashboard updated.",
    "อัปเดตแดชบอร์ดแล้ว แต่ข้อมูลบางรายการไม่พร้อมใช้งาน": "Dashboard updated with some metrics unavailable.",
    "โหลดภาพรวมไม่สำเร็จ โหลดหน้าเว็บอีกครั้งเพื่อลองใหม่": "Unable to load overview. Reload the page to retry.",
    "โหลดไลบรารี Supabase สำหรับเบราว์เซอร์ไม่สำเร็จ": "Supabase browser library did not load.",
    "โหลดภาพรวมไม่สำเร็จ ตรวจสอบการตั้งค่าแดชบอร์ดแล้วโหลดหน้าเว็บอีกครั้ง": "Unable to load overview. Check the dashboard configuration and reload.",
    "คัดลอก config.example.js เป็น config.js แล้วเพิ่ม Supabase URL และ publishable key": "Copy config.example.js to config.js and add the Supabase URL and publishable key.",
    "เปลี่ยนเป็นภาษาอังกฤษ": "Switch to English", "เปลี่ยนเป็นภาษาไทย": "Switch to Thai",
  };
const STORAGE_KEY = "lang";
  const LOCALES = { th: "th-TH-u-nu-latn", en: "en-US" };
  let lang = "th";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "th" || saved === "en") lang = saved;
  } catch { /* storage unavailable */ }

  function fill(text, params) {
    return params ? text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? params[key] : match)) : text;
  }

  // `english` overrides the catalog when one Thai phrase needs different English by context.
  function t(thai, params, english) {
    if (lang !== "en") return fill(thai, params);
    const entry = english ?? EN[thai];
    if (typeof entry === "function") return entry(params || {});
    return fill(entry ?? thai, params);
  }

  function map(labels) {
    return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, t(value)]));
  }

  function translateStatic() {
    document.documentElement.lang = lang;
    document.title = t(document.title);
    if (lang !== "en") return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text && typeof EN[text] === "string") node.nodeValue = node.nodeValue.replace(text, EN[text]);
    }
    document.querySelectorAll("[title], [aria-label], [placeholder]").forEach((element) => {
      ["title", "aria-label", "placeholder"].forEach((name) => {
        const value = element.getAttribute(name);
        if (value && typeof EN[value] === "string") element.setAttribute(name, EN[value]);
      });
    });
  }

  function setLang(next) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
    // Text is rendered from many places, so a reload is the simplest way to keep it consistent.
    location.reload();
  }

  window.I18N = { t, map, setLang, translateStatic, get lang() { return lang; }, get locale() { return LOCALES[lang]; } };
})();
