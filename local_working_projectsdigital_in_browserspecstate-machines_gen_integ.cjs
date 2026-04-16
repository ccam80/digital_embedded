var fs = require("fs");
var B = String.fromCharCode(96);
var s = "";
function w(t) { s += (t===undefined?"":t) + "
"; }
function r(a,b,c) { w("| " + a + " | " + b + " | " + c + " |"); }
function h() { w("|---|---|---|"); }
function q(t) { return B+t+B; }

// Content will be appended by subsequent chunks
module.exports = { w, r, h, q, getContent: function(){ return s; } };