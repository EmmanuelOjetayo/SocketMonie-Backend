const mongoose = require("mongoose")
const dotenv = require("dotenv")

dotenv.config({path:require("path").join(__dirname, "../.env")})
const MONGO_URL = process.env.MONGO_URL

function db(){
    mongoose.connect(MONGO_URL).then(()=>{
        console.log("Database connected Successfully")
    })
}
module.exports = db;
