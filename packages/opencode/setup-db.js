const { Database } = require('bun:sqlite');
const db = new Database('./sample.db');
db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, active INTEGER); INSERT INTO users(name,active) VALUES ("alice",1),("bob",0),("carol",1); CREATE TABLE logs(id INTEGER PRIMARY KEY, msg TEXT);');
db.close();
console.log('db created');
