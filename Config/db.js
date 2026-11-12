const mongoose = require("mongoose")
const dotenv = require("dotenv")
const { ensureNullableUniqueIndexes } = require("../Utilis/indexMigrations")

dotenv.config({path:require("path").join(__dirname, "../.env")})
const MONGO_URL = process.env.MONGO_URL

function db(){
    mongoose.connect(MONGO_URL).then(async ()=>{
        console.log("Database connected Successfully")
        // Self-healing index migration: nullable unique fields must be
        // protected by a PARTIAL unique index (sparse alone does not exclude
        // `null`, which made the second such document fail with E11000).
        try {
            await ensureNullableUniqueIndexes(mongoose.connection.db)
        } catch (migrationError) {
            console.error("Index migration failed:", migrationError.message)
        }
    })
}
module.exports = db;
