const TARGET_TABLE = "TargetD1Table"; // for the tutorial, `TargetD1Table`
const ACCOUNT_ID = "0cf8898f7cdc52de3442ce954467a53f";
const DATABASE_ID = "d1-import";
const D1_API_KEY = "cfut_0WqXX2pZcD7wLaXC8SMfEQ6RDuRAgTCIhtz5ryCua3ac0d2f";
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/import`;
const filename = crypto.randomUUID(); // create a random filename
const uploadSize = 500;
const headers = {
	"Content-Type": "application/json",
	Authorization: `Bearer ${D1_API_KEY}`,
};
