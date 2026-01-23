import 'dotenv/config';
import { connectDB, Skin } from './src/db.js';
import { cfg } from './src/config.js';

async function checkDatabase() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await connectDB(cfg.mongoUri);
    
    // Lấy tổng số documents
    const totalCount = await Skin.countDocuments();
    console.log(`\n📊 Total records in database: ${totalCount}\n`);
    
    if (totalCount === 0) {
      console.log('⚠️  Database is empty. Run scraper first!');
      process.exit(0);
    }
    
    // Lấy 10 records mới nhất
    console.log('📋 Latest 10 records:\n');
    const latest = await Skin.find()
      .sort({ scrapedAt: -1 })
      .limit(10)
      .lean();
    
    latest.forEach((doc, index) => {
      console.log(`\n[${index + 1}] ==========================================`);
      console.log(`ID: ${doc.id || 'N/A'}`);
      console.log(`Title: ${doc.title || 'N/A'}`);
      console.log(`Customer Info: ${doc.customerInfo || 'N/A'}`);
      console.log(`Gender: ${doc.gender || 'N/A'}`);
      console.log(`Device Number: ${doc.deviceNumber || 'N/A'}`);
      console.log(`Account: ${doc.account || 'N/A'}`);
      console.log(`Test Time: ${doc.testTime || 'N/A'}`);
      console.log(`Test Status: ${doc.testStatus || 'N/A'}`);
      console.log(`Remarks: ${doc.remarks || 'N/A'}`);
      console.log(`Image: ${doc.image ? doc.image.substring(0, 50) + '...' : 'N/A'}`);
      console.log(`URL: ${doc.url || 'N/A'}`);
      console.log(`Source ID: ${doc.sourceId || 'N/A'}`);
      console.log(`Scraped At: ${doc.scrapedAt ? new Date(doc.scrapedAt).toLocaleString() : 'N/A'}`);
      console.log(`Created At: ${doc.createdAt ? new Date(doc.createdAt).toLocaleString() : 'N/A'}`);
    });
    
    // Thống kê
    console.log('\n\n📈 STATISTICS\n');
    
    // Count by gender
    const genderStats = await Skin.aggregate([
      { $group: { _id: '$gender', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    if (genderStats.length > 0) {
      console.log('By Gender:');
      genderStats.forEach(stat => {
        console.log(`  ${stat._id || 'Unknown'}: ${stat.count}`);
      });
    }
    
    // Count by account
    const accountStats = await Skin.aggregate([
      { $group: { _id: '$account', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);
    if (accountStats.length > 0) {
      console.log('\nTop 5 Accounts:');
      accountStats.forEach(stat => {
        console.log(`  ${stat._id || 'Unknown'}: ${stat.count}`);
      });
    }
    
    // Count by test status
    const statusStats = await Skin.aggregate([
      { $group: { _id: '$testStatus', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    if (statusStats.length > 0) {
      console.log('\nBy Test Status:');
      statusStats.forEach(stat => {
        console.log(`  ${stat._id || 'Unknown'}: ${stat.count}`);
      });
    }
    
    // Recent scrapes
    const recentScrapes = await Skin.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d %H:%M', date: '$scrapedAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: -1 } },
      { $limit: 5 }
    ]);
    if (recentScrapes.length > 0) {
      console.log('\nRecent Scrapes:');
      recentScrapes.forEach(stat => {
        console.log(`  ${stat._id}: ${stat.count} records`);
      });
    }
    
    // Oldest and newest
    const oldest = await Skin.findOne().sort({ scrapedAt: 1 }).lean();
    const newest = await Skin.findOne().sort({ scrapedAt: -1 }).lean();
    
    console.log('\n⏰ Timeline:');
    if (oldest) {
      console.log(`  Oldest record: ${new Date(oldest.scrapedAt).toLocaleString()}`);
    }
    if (newest) {
      console.log(`  Newest record: ${new Date(newest.scrapedAt).toLocaleString()}`);
    }
    
    console.log('\n✅ Done!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Xử lý command line arguments
const args = process.argv.slice(2);
const command = args[0];

if (command === 'export') {
  // Export to JSON
  (async () => {
    try {
      await connectDB(cfg.mongoUri);
      const allData = await Skin.find().lean();
      const fs = await import('fs');
      const filename = `export-${new Date().toISOString().split('T')[0]}.json`;
      fs.writeFileSync(filename, JSON.stringify(allData, null, 2));
      console.log(`✅ Exported ${allData.length} records to ${filename}`);
      process.exit(0);
    } catch (error) {
      console.error('❌ Export error:', error.message);
      process.exit(1);
    }
  })();
} else if (command === 'count') {
  // Chỉ hiển thị số lượng
  (async () => {
    try {
      await connectDB(cfg.mongoUri);
      const count = await Skin.countDocuments();
      console.log(`📊 Total records: ${count}`);
      process.exit(0);
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  })();
} else if (command === 'search') {
  // Tìm kiếm
  const searchTerm = args[1];
  if (!searchTerm) {
    console.error('❌ Please provide a search term: node check-db.js search <term>');
    process.exit(1);
  }
  (async () => {
    try {
      await connectDB(cfg.mongoUri);
      const results = await Skin.find({
        $or: [
          { id: { $regex: searchTerm, $options: 'i' } },
          { customerInfo: { $regex: searchTerm, $options: 'i' } },
          { account: { $regex: searchTerm, $options: 'i' } },
          { deviceNumber: { $regex: searchTerm, $options: 'i' } }
        ]
      }).limit(20).lean();
      
      console.log(`\n🔍 Found ${results.length} records matching "${searchTerm}":\n`);
      results.forEach((doc, index) => {
        console.log(`[${index + 1}] ID: ${doc.id || 'N/A'} | Account: ${doc.account || 'N/A'} | Device: ${doc.deviceNumber || 'N/A'}`);
      });
      process.exit(0);
    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  })();
} else {
  // Mặc định: hiển thị đầy đủ
  checkDatabase();
}


