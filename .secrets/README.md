# .secrets

Isi folder ini tidak pernah masuk git. Taruh kunci di sini, bukan di root repo atau di Downloads.

`.gitignore` mengabaikan **seluruh isi folder kecuali berkas ini**, jadi berkas baru apa pun aman
secara default — pola yang kebalikan dari mendaftar nama satu per satu, di mana berkas yang lupa
didaftarkan adalah berkas yang bocor.

Yang diharapkan di sini:

- `*.pem` — kunci SSH ke server produksi

Catatan: membaca database produksi **tidak butuh** kunci ini. `scratch/prod-query.ts` memakai
`DATABASE_URL` dari `.env` lewat koneksi Prisma yang sama dengan app, jadi tidak ada jalur akses
baru yang perlu dibuka.
