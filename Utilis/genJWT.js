const jwt = require("jsonwebtoken")

const genJWT = (id)=>{
    return jwt.sign(
        {id},
        process.env.JWT_SECRET,
        {"expiresIn": "1hr"}
    )
}

module.exports = genJWT;