---
trigger: /commit
description: Langkah-langkah otomatis untuk melakukan commit dengan standar Conventional Commits
---

# 🔄 Workflow: Git Commit (Conventional Commits)

Gunakan workflow ini setiap kali Amirull memberikan perintah `/commit`.

## 📝 Langkah-langkah:

1. **Staging Changes**:
   - Jalankan `git add .` untuk memasukkan semua perubahan terbaru.

2. **Analyze Context**:
   - Identifikasi konteks perubahan (misal: Infrastruktur, Keamanan, atau Fitur).
   - Jika perubahan terlalu luas, bagi menjadi beberapa commit yang logis.

3. **Generate Contextual Message**:
   - Buat pesan commit yang benar-benar menggambarkan apa yang diperbaiki.
   - Format: `<type>(<scope>): <description>`
   - Contoh: `fix(dns): implement doh fallback and hardcoded ips`

4. **Execute Commit**:
   - Jalankan `git commit -m "[Generated Message]"`.

5. **Feedback**:
   - Berikan laporan singkat ke Amirull bahwa commit telah berhasil dilakukan beserta pesan commitnya.

---
*Workflow ini memastikan sejarah Git kita tetap rapi dan mudah dibaca.*
