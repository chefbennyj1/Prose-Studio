const db = require('../services/db');
const Schema = db.Schema;

const userSchema = new Schema({
    username : {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    password : {
        type: String,
        required: true
    },
    age: {
        type: Number,
        min: 18,
        validate: {
            validator: v => v >= 18,
            message: "You must be 18 or older to access this site", //"${props.value}"
        }
    },
    role: {
        type: String,
        enum: ['basic', 'moderator', 'admin'],
        default: 'basic'
    },
    avatar: {
        type: String,
        default: null
    }
},
{
    timestamps: true  
});

module.exports = db.model("User", userSchema);