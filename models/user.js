var mongoose = require('mongoose');

var userSchema = mongoose.Schema({ id: String });
var User = mongoose.model('User', userSchema);

exports.add_user = function(user_id) {
  var newUser = new User({ id: user_id });
  newUser.save(function(err, newUser) {
    if (err) { return console.error(err); }
    console.log("[DB] New user with ID: %s  has been added to the database.", newUser.id);
  });
};

exports.get_all_users = function(callback) {
  User.find(function (err, users) {
    if (err) { return console.error(err); }
    callback(users);
  });
};

exports.get_other_users = function(user_id, callback) {
  // Get all users except user with id: user_id
  User.find({ id: { $ne: user_id } }, function (err, users) {
    if (err) { return console.error(err); }
    callback(users);
  });
}

exports.count = function(callback) {
  User.count({}, function(err, count){
    if (err) { return console.error(err); }
    callback(count);
  });
};
