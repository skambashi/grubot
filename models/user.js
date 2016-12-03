var mongoose = require('mongoose');

var userSchema = mongoose.Schema({ id: String }, { _id: false });
var User = mongoose.model('User', userSchema);

exports.add_user = function(user_id) {
  var newUser = new User({ id: user_id });
  newUser.save(function(err, newUser) {
    if (err) { return console.error(err); }
    console.log("[DB|USER] User with ID: %s added to database", newUser.id);
  });
};
