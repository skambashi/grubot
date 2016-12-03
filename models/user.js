var mongoose = require('mongoose');

var userSchema = mongoose.Schema({ id: String });
var User = mongoose.model('User', userSchema);

exports.add_user = function(user_id) {
  var newUser = new User({ id: user_id });
  newUser.save(function(err, newUser) {
    if (err) { return console.error(err); }
    console.log("[DB|USER] User with ID: %s added to database", newUser.id);
  });
};

exports.count = function(callback) {
  User.count({}, function(err, count){
    if (err) { return console.error(err); }
    callback(count);
  });
};
