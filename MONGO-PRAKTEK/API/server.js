// server.js

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const port = 3000; // API kita akan berjalan di port 3000
app.use(express.json());

// ---- Konfigurasi Koneksi MongoDB ----
// Kita akan mengambil info koneksi dari Environment Variables
// yang akan kita set di docker-compose.yml

// Perhatikan: host-nya adalah 'mongo', nama service di docker-compose
const host = process.env.MONGO_HOST || 'mongo'; 
const user = process.env.MONGO_USER || 'admin';
const password = process.env.MONGO_PASSWORD || 'password';
const dbName = 'db_kampus'; // Kita akan gunakan db_kampus

// Jika credentials adalah root user yang dibuat oleh MONGO_INITDB_ROOT_USERNAME
// maka kita perlu menghubungkan dengan authSource=admin
const url = `mongodb://${user}:${password}@${host}:27017/?authSource=admin`;

let db;
let client;

// Connect with retry/backoff so container doesn't immediately exit if MongoDB
// is not yet ready. This is friendlier than process.exit and works well with
// Docker restart policies.
async function connectWithRetry(retries = 0) {
    try {
        client = new MongoClient(url);
        console.log(`Mencoba terhubung ke MongoDB di: ${host}...`);
        await client.connect();
        console.log('Berhasil terhubung ke MongoDB!');

        db = client.db(dbName);

        // Pastikan collection 'posts' ada (buat jika belum ada)
        const existingPosts = await db.listCollections({ name: 'posts' }).toArray();
        if (existingPosts.length === 0) {
            await db.createCollection('posts');
            console.log("Collection 'posts' dibuat.");
        }

        // === SETUP COLLECTION PRODUK (PRAKTIK 2) ===
        // Pastikan collection 'produk' ada (buat jika belum ada)
        const existingProduk = await db.listCollections({ name: 'produk' }).toArray();
        if (existingProduk.length === 0) {
            await db.createCollection('produk');
            console.log("Collection 'produk' dibuat untuk CRUD produk.");
        }

        // Buat indexes untuk collection 'produk' untuk performa yang lebih baik
        try {
            // Index untuk kode_produk (unique constraint)
            await db.collection('produk').createIndex(
                { "kode_produk": 1 }, 
                { unique: true, name: "idx_kode_produk_unique" }
            );
            console.log("Index unique untuk kode_produk dibuat.");

            // Index untuk search text di nama_produk dan deskripsi
            await db.collection('produk').createIndex(
                { "nama_produk": "text", "deskripsi": "text" },
                { name: "idx_produk_text_search" }
            );
            console.log("Index text search untuk produk dibuat.");

            // Index untuk kategori (sering digunakan untuk filter)
            await db.collection('produk').createIndex(
                { "kategori": 1 },
                { name: "idx_kategori" }
            );
            console.log("Index untuk kategori dibuat.");

            // Index untuk harga (untuk range queries)
            await db.collection('produk').createIndex(
                { "harga": 1 },
                { name: "idx_harga" }
            );
            console.log("Index untuk harga dibuat.");

        } catch (indexError) {
            // Ignore error jika index sudah ada (error code 85 = IndexOptionsConflict)
            if (indexError.code !== 85) {
                console.error('Error membuat indexes:', indexError.message);
            }
        }

        app.listen(port, () => {
            console.log(`Server API berjalan di http://localhost:${port}`);
        });
    } catch (err) {
        console.error('Koneksi ke MongoDB gagal:', err.message || err);
        // Exponential backoff, cap at 30s
        const delay = Math.min(30000, 1000 * Math.pow(2, retries));
        console.log(`Mencoba lagi dalam ${Math.round(delay/1000)} detik... (attempt ${retries+1})`);
        setTimeout(() => connectWithRetry(retries + 1), delay);
    }
}

// Start initial connect attempts
connectWithRetry();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('SIGINT diterima, menutup koneksi...');
    try {
        if (client) await client.close();
    } finally {
        process.exit(0);
    }
});
process.on('SIGTERM', async () => {
    console.log('SIGTERM diterima, menutup koneksi...');
    try {
        if (client) await client.close();
    } finally {
        process.exit(0);
    }
});

// ---- API Endpoints ----

// GET /posts (Membaca semua postingan dengan search dan pagination)
app.get('/posts', async (req, res) => {
    try {
        const { search, page = 1, limit = 10 } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;
        
        // Build filter untuk search
        let filter = {};
        if (search) {
            filter = {
                $or: [
                    { title: { $regex: search, $options: 'i' } }, // Case insensitive search di title
                    { content: { $regex: search, $options: 'i' } }, // Case insensitive search di content
                    { author: { $regex: search, $options: 'i' } } // Case insensitive search di author
                ]
            };
        }
        
        // Ambil data dengan pagination dan search
        const posts = await db.collection('posts')
            .find(filter)
            .sort({ _id: -1 }) // Urutkan terbaru dulu
            .skip(skip)
            .limit(limitNum)
            .toArray();
            
        // Hitung total data untuk pagination info
        const total = await db.collection('posts').countDocuments(filter);
        
        res.status(200).json({
            success: true,
            data: posts,
            pagination: {
                current_page: pageNum,
                total_pages: Math.ceil(total / limitNum),
                total_data: total,
                per_page: limitNum,
                has_next: pageNum < Math.ceil(total / limitNum),
                has_prev: pageNum > 1
            },
            search_query: search || null
        });
    } catch (err) {
        console.error('Error GET /posts:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data posts',
            error: err.message 
        });
    }
});

// GET /posts/:id (Membaca post berdasarkan ID)
app.get('/posts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validasi ObjectId
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'ID post tidak valid'
            });
        }
        
        const post = await db.collection('posts').findOne({ _id: new ObjectId(id) });
        
        if (!post) {
            return res.status(404).json({
                success: false,
                message: 'Post tidak ditemukan'
            });
        }
        
        res.status(200).json({
            success: true,
            data: post
        });
    } catch (err) {
        console.error('Error GET /posts/:id:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data post',
            error: err.message 
        });
    }
});

// GET /posts/search/advanced (Pencarian lanjutan dengan filter)
app.get('/posts/search/advanced', async (req, res) => {
    try {
        const { title, author, content, date_from, date_to } = req.query;
        
        if (!title && !author && !content && !date_from && !date_to) {
            return res.status(400).json({
                success: false,
                message: 'Minimal satu parameter pencarian harus diisi'
            });
        }
        
        // Build advanced filter
        let filter = {};
        
        if (title) {
            filter.title = { $regex: title, $options: 'i' };
        }
        
        if (author) {
            filter.author = { $regex: author, $options: 'i' };
        }
        
        if (content) {
            filter.content = { $regex: content, $options: 'i' };
        }
        
        // Filter berdasarkan tanggal jika ada field created_at
        if (date_from || date_to) {
            filter.created_at = {};
            if (date_from) filter.created_at.$gte = new Date(date_from);
            if (date_to) filter.created_at.$lte = new Date(date_to);
        }
        
        const posts = await db.collection('posts')
            .find(filter)
            .sort({ _id: -1 })
            .limit(50) // Batasi hasil pencarian
            .toArray();
        
        res.status(200).json({
            success: true,
            message: `Ditemukan ${posts.length} posts`,
            data: posts,
            filter_used: filter
        });
    } catch (err) {
        console.error('Error GET /posts/search/advanced:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mencari posts',
            error: err.message 
        });
    }
});

// POST /posts (Membuat postingan baru)
app.post('/posts', async (req, res) => {
    try {
        const dataBaru = req.body;
        if (!dataBaru || Object.keys(dataBaru).length === 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Body request tidak boleh kosong' 
            });
        }
        
        // Tambahkan timestamp
        const postBaru = {
            ...dataBaru,
            created_at: new Date(),
            updated_at: new Date()
        };
        
        const result = await db.collection('posts').insertOne(postBaru);
        
        res.status(201).json({
            success: true,
            message: 'Post berhasil dibuat',
            data: {
                _id: result.insertedId,
                ...postBaru
            }
        });
    } catch (err) {
        console.error('Error POST /posts:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal membuat post',
            error: err.message 
        });
    }
});

// PUT /posts/:id (Update postingan)
app.put('/posts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        
        // Validasi ObjectId
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'ID post tidak valid'
            });
        }
        
        // Validasi data update
        if (!updateData || Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Data untuk update tidak boleh kosong'
            });
        }
        
        // Cek apakah post exists
        const existingPost = await db.collection('posts').findOne({ _id: new ObjectId(id) });
        if (!existingPost) {
            return res.status(404).json({
                success: false,
                message: 'Post tidak ditemukan'
            });
        }
        
        // Siapkan data update dengan timestamp
        const dataToUpdate = {
            ...updateData,
            updated_at: new Date()
        };
        
        // Update post
        const result = await db.collection('posts').updateOne(
            { _id: new ObjectId(id) },
            { $set: dataToUpdate }
        );
        
        if (result.modifiedCount === 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak ada perubahan data'
            });
        }
        
        // Ambil data post yang sudah diupdate
        const updatedPost = await db.collection('posts').findOne({ _id: new ObjectId(id) });
        
        res.status(200).json({
            success: true,
            message: 'Post berhasil diupdate',
            data: updatedPost
        });
    } catch (err) {
        console.error('Error PUT /posts/:id:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengupdate post',
            error: err.message 
        });
    }
});

// DELETE /posts/:id (Hapus postingan)
app.delete('/posts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validasi ObjectId
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'ID post tidak valid'
            });
        }
        
        // Cek apakah post exists sebelum dihapus
        const existingPost = await db.collection('posts').findOne({ _id: new ObjectId(id) });
        if (!existingPost) {
            return res.status(404).json({
                success: false,
                message: 'Post tidak ditemukan'
            });
        }
        
        // Hapus post
        const result = await db.collection('posts').deleteOne({ _id: new ObjectId(id) });
        
        res.status(200).json({
            success: true,
            message: 'Post berhasil dihapus',
            deleted_data: existingPost
        });
    } catch (err) {
        console.error('Error DELETE /posts/:id:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal menghapus post',
            error: err.message 
        });
    }
});

// =============================================================================
// PRODUK CRUD ENDPOINTS - Praktik 2: Structured Business Application
// =============================================================================

// Fungsi validasi untuk data produk - digunakan untuk memastikan data yang masuk valid
function validateProduk(data) {
    const errors = []; // Array untuk menyimpan pesan error
    
    // Validasi kode produk - harus ada dan tidak kosong
    if (!data.kode_produk || data.kode_produk.trim() === '') {
        errors.push('Kode produk wajib diisi');
    }
    
    // Validasi nama produk - harus ada dan minimal 3 karakter
    if (!data.nama_produk || data.nama_produk.trim().length < 3) {
        errors.push('Nama produk wajib diisi minimal 3 karakter');
    }
    
    // Validasi kategori - harus ada dan tidak kosong
    if (!data.kategori || data.kategori.trim() === '') {
        errors.push('Kategori wajib diisi');
    }
    
    // Validasi harga - harus ada, berupa angka, dan lebih besar dari 0
    if (!data.harga || isNaN(data.harga) || parseFloat(data.harga) <= 0) {
        errors.push('Harga harus berupa angka dan lebih besar dari 0');
    }
    
    // Validasi stok - harus ada, berupa angka, dan tidak boleh negatif
    if (data.stok === undefined || isNaN(data.stok) || parseInt(data.stok) < 0) {
        errors.push('Stok harus berupa angka dan tidak boleh negatif');
    }
    
    return errors; // Return array errors (kosong jika tidak ada error)
}

// GET /api/produk - Ambil semua produk dengan pagination dan search
app.get('/api/produk', async (req, res) => {
    try {
        // Extract query parameters dengan default values
        const { search, kategori, min_harga, max_harga, page = 1, limit = 10 } = req.query;
        const pageNum = parseInt(page); // Convert string ke number
        const limitNum = parseInt(limit); // Convert string ke number
        const skip = (pageNum - 1) * limitNum; // Hitung berapa data yang di-skip untuk pagination
        
        // Build filter object untuk query MongoDB
        let filter = {};
        
        // Jika ada parameter search, cari di nama_produk dan deskripsi (case insensitive)
        if (search) {
            filter.$or = [
                { nama_produk: { $regex: search, $options: 'i' } },
                { deskripsi: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Jika ada filter kategori, tambahkan ke filter (case insensitive)
        if (kategori) {
            filter.kategori = { $regex: kategori, $options: 'i' };
        }
        
        // Jika ada filter harga, tambahkan range filter
        if (min_harga || max_harga) {
            filter.harga = {}; // Inisialisasi object untuk harga filter
            if (min_harga) filter.harga.$gte = parseFloat(min_harga); // Greater than or equal
            if (max_harga) filter.harga.$lte = parseFloat(max_harga); // Less than or equal
        }
        
        // Query database dengan filter, sorting, dan pagination
        const produk = await db.collection('produk')
            .find(filter) // Apply filter yang sudah dibuild
            .sort({ tanggal_dibuat: -1 }) // Sort berdasarkan tanggal terbaru
            .skip(skip) // Skip data untuk pagination
            .limit(limitNum) // Limit jumlah data yang diambil
            .toArray(); // Convert MongoDB cursor ke JavaScript array
            
        // Hitung total data untuk pagination info
        const total = await db.collection('produk').countDocuments(filter);
        
        // Response dengan format yang konsisten
        res.status(200).json({
            success: true,
            message: `Ditemukan ${produk.length} produk`,
            data: produk,
            pagination: {
                current_page: pageNum,
                total_pages: Math.ceil(total / limitNum), // Hitung total halaman
                total_data: total,
                per_page: limitNum,
                has_next: pageNum < Math.ceil(total / limitNum), // Ada halaman selanjutnya?
                has_prev: pageNum > 1 // Ada halaman sebelumnya?
            },
            filters_applied: { // Info filter yang digunakan untuk debugging
                search: search || null,
                kategori: kategori || null,
                min_harga: min_harga || null,
                max_harga: max_harga || null
            }
        });
    } catch (err) {
        console.error('Error GET /api/produk:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data produk',
            error: err.message 
        });
    }
});

// GET /api/produk/:id - Ambil produk berdasarkan ID
app.get('/api/produk/:id', async (req, res) => {
    try {
        const { id } = req.params; // Extract ID dari URL parameter
        
        // Validasi apakah ID yang diberikan adalah ObjectId yang valid
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'ID produk tidak valid. Gunakan format ObjectId yang benar.'
            });
        }
        
        // Cari produk berdasarkan ID
        const produk = await db.collection('produk').findOne({ _id: new ObjectId(id) });
        
        // Jika produk tidak ditemukan, return 404
        if (!produk) {
            return res.status(404).json({
                success: false,
                message: 'Produk dengan ID tersebut tidak ditemukan'
            });
        }
        
        // Return produk yang ditemukan
        res.status(200).json({
            success: true,
            message: 'Produk berhasil ditemukan',
            data: produk
        });
    } catch (err) {
        console.error('Error GET /api/produk/:id:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data produk',
            error: err.message 
        });
    }
});

// POST /api/produk - Tambah produk baru
app.post('/api/produk', async (req, res) => {
    try {
        const dataProduk = req.body; // Ambil data dari request body
        
        // Validasi data menggunakan fungsi validateProduk
        const errors = validateProduk(dataProduk);
        if (errors.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Data produk tidak valid',
                errors: errors // Return semua error yang ditemukan
            });
        }
        
        // Cek apakah kode produk sudah digunakan (unique constraint)
        const existingProduk = await db.collection('produk').findOne({ 
            kode_produk: dataProduk.kode_produk.trim() 
        });
        
        if (existingProduk) {
            return res.status(409).json({
                success: false,
                message: 'Kode produk sudah digunakan. Gunakan kode yang berbeda.'
            });
        }
        
        // Siapkan data produk dengan format yang konsisten
        const produkBaru = {
            kode_produk: dataProduk.kode_produk.trim(), // Remove whitespace
            nama_produk: dataProduk.nama_produk.trim(),
            kategori: dataProduk.kategori.trim(),
            harga: parseFloat(dataProduk.harga), // Convert ke number
            stok: parseInt(dataProduk.stok), // Convert ke integer
            deskripsi: dataProduk.deskripsi ? dataProduk.deskripsi.trim() : '', // Optional field
            supplier: dataProduk.supplier ? dataProduk.supplier.trim() : '', // Optional field
            tanggal_dibuat: new Date(), // Timestamp otomatis
            tanggal_diupdate: new Date(), // Timestamp otomatis
            status: 'aktif' // Default status
        };
        
        // Insert ke database
        const result = await db.collection('produk').insertOne(produkBaru);
        
        // Response sukses dengan data yang baru dibuat
        res.status(201).json({
            success: true,
            message: 'Produk berhasil ditambahkan',
            data: {
                _id: result.insertedId, // ID yang di-generate MongoDB
                ...produkBaru // Spread semua data produk
            }
        });
    } catch (err) {
        console.error('Error POST /api/produk:', err);
        
        // Handle duplicate key error (jika ada unique index)
        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Kode produk sudah digunakan'
            });
        }
        
        res.status(500).json({ 
            success: false,
            message: 'Gagal menambahkan produk',
            error: err.message 
        });
    }
});

// PUT /api/produk/:id - Update produk
app.put('/api/produk/:id', async (req, res) => {
    try {
        const { id } = req.params; // Extract ID dari URL
        const dataProduk = req.body; // Ambil data update dari request body
        
        // Validasi ObjectId
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'ID produk tidak valid'
            });
        }
        
        // Validasi data update
        const errors = validateProduk(dataProduk);
        if (errors.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Data produk tidak valid',
                errors: errors
            });
        }
        
        // Cek apakah produk yang akan di-update ada
        const existingProduk = await db.collection('produk').findOne({ _id: new ObjectId(id) });
        if (!existingProduk) {
            return res.status(404).json({
                success: false,
                message: 'Produk tidak ditemukan'
            });
        }
        
        // Cek apakah kode produk sudah digunakan oleh produk lain
        const duplicateCheck = await db.collection('produk').findOne({ 
            kode_produk: dataProduk.kode_produk.trim(),
            _id: { $ne: new ObjectId(id) } // Exclude current product
        });
        
        if (duplicateCheck) {
            return res.status(409).json({
                success: false,
                message: 'Kode produk sudah digunakan oleh produk lain'
            });
        }
        
        // Siapkan data update (preserve tanggal_dibuat, update tanggal_diupdate)
        const updateData = {
            kode_produk: dataProduk.kode_produk.trim(),
            nama_produk: dataProduk.nama_produk.trim(),
            kategori: dataProduk.kategori.trim(),
            harga: parseFloat(dataProduk.harga),
            stok: parseInt(dataProduk.stok),
            deskripsi: dataProduk.deskripsi ? dataProduk.deskripsi.trim() : '',
            supplier: dataProduk.supplier ? dataProduk.supplier.trim() : '',
            tanggal_diupdate: new Date() // Update timestamp
            // tanggal_dibuat tetap tidak berubah
        };
        
        // Update produk di database
        const result = await db.collection('produk').updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData } // $set operator untuk update fields
        );
        
        // Cek apakah ada data yang berubah
        if (result.modifiedCount === 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak ada perubahan data atau data sama dengan sebelumnya'
            });
        }
        
        // Ambil data produk yang sudah di-update untuk response
        const updatedProduk = await db.collection('produk').findOne({ _id: new ObjectId(id) });
        
        res.status(200).json({
            success: true,
            message: 'Produk berhasil diupdate',
            data: updatedProduk
        });
    } catch (err) {
        console.error('Error PUT /api/produk/:id:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengupdate produk',
            error: err.message 
        });
    }
});

// DELETE /api/produk/:id - Hapus produk
app.delete('/api/produk/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validasi ObjectId
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'ID produk tidak valid'
            });
        }
        
        // Cek apakah produk exists sebelum dihapus
        const existingProduk = await db.collection('produk').findOne({ _id: new ObjectId(id) });
        if (!existingProduk) {
            return res.status(404).json({
                success: false,
                message: 'Produk tidak ditemukan'
            });
        }
        
        // Hapus produk dari database
        const result = await db.collection('produk').deleteOne({ _id: new ObjectId(id) });
        
        res.status(200).json({
            success: true,
            message: 'Produk berhasil dihapus',
            deleted_data: existingProduk // Return data yang dihapus untuk konfirmasi
        });
    } catch (err) {
        console.error('Error DELETE /api/produk/:id:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal menghapus produk',
            error: err.message 
        });
    }
});

// GET /api/produk/search/advanced - Advanced search untuk produk
app.get('/api/produk/search/advanced', async (req, res) => {
    try {
        const { nama, kode, kategori, min_harga, max_harga, supplier, stok_kosong } = req.query;
        
        // Minimal harus ada satu parameter search
        if (!nama && !kode && !kategori && !min_harga && !max_harga && !supplier && !stok_kosong) {
            return res.status(400).json({
                success: false,
                message: 'Minimal satu parameter pencarian harus diisi'
            });
        }
        
        // Build advanced filter object
        let filter = {};
        
        // Filter berdasarkan nama produk (partial match, case insensitive)
        if (nama) {
            filter.nama_produk = { $regex: nama, $options: 'i' };
        }
        
        // Filter berdasarkan kode produk (partial match, case insensitive)
        if (kode) {
            filter.kode_produk = { $regex: kode, $options: 'i' };
        }
        
        // Filter berdasarkan kategori (partial match, case insensitive)
        if (kategori) {
            filter.kategori = { $regex: kategori, $options: 'i' };
        }
        
        // Filter berdasarkan supplier (partial match, case insensitive)
        if (supplier) {
            filter.supplier = { $regex: supplier, $options: 'i' };
        }
        
        // Filter berdasarkan range harga
        if (min_harga || max_harga) {
            filter.harga = {};
            if (min_harga) filter.harga.$gte = parseFloat(min_harga);
            if (max_harga) filter.harga.$lte = parseFloat(max_harga);
        }
        
        // Filter produk dengan stok kosong (jika parameter stok_kosong=true)
        if (stok_kosong === 'true') {
            filter.stok = { $lte: 0 }; // Stok <= 0
        }
        
        // Query database dengan filter yang kompleks
        const produk = await db.collection('produk')
            .find(filter)
            .sort({ tanggal_dibuat: -1 }) // Sort terbaru dulu
            .limit(100) // Batasi hasil maksimal 100 untuk performa
            .toArray();
        
        res.status(200).json({
            success: true,
            message: `Ditemukan ${produk.length} produk`,
            data: produk,
            filters_applied: filter // Show filter yang digunakan
        });
    } catch (err) {
        console.error('Error GET /api/produk/search/advanced:', err);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mencari produk',
            error: err.message 
        });
    }
});

// =============================================================================
// HEALTH CHECK ENDPOINT - Monitoring kedua sistem (posts & produk)
// =============================================================================

// Health check endpoint yang sudah di-update untuk mencakup kedua sistem
app.get('/health', async (req, res) => {
    try {
        // Hitung statistik untuk kedua collection
        const postsCount = await db.collection('posts').countDocuments({});
        const produkCount = await db.collection('produk').countDocuments({});
        
        res.status(200).json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            database: db ? 'Connected' : 'Disconnected',
            statistics: {
                total_posts: postsCount,
                total_produk: produkCount
            },
            endpoints: {
                posts_crud: [
                    'GET /posts - Ambil semua posts (dengan search & pagination)',
                    'GET /posts/:id - Ambil post berdasarkan ID',
                    'GET /posts/search/advanced - Pencarian lanjutan posts',
                    'POST /posts - Buat post baru',
                    'PUT /posts/:id - Update post',
                    'DELETE /posts/:id - Hapus post'
                ],
                produk_crud: [
                    'GET /api/produk - Ambil semua produk (dengan search & filter)',
                    'GET /api/produk/:id - Ambil produk berdasarkan ID',
                    'GET /api/produk/search/advanced - Pencarian lanjutan produk',
                    'POST /api/produk - Tambah produk baru',
                    'PUT /api/produk/:id - Update produk',
                    'DELETE /api/produk/:id - Hapus produk'
                ],
                system: [
                    'GET /health - Health check & statistics'
                ]
            }
        });
    } catch (err) {
        res.status(500).json({
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            database: 'Error',
            error: err.message
        });
    }
});

// 404 handler untuk endpoint yang tidak ada
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `Endpoint ${req.method} ${req.path} tidak ditemukan`
    });
});