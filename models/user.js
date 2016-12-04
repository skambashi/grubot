var mongoose = require('mongoose');

var userSchema = mongoose.Schema({
  id: String,
  state: String,
  first_name: String,
  last_name: String,
  timezone: Number,
  gender: String,
  buildingPollId: String
});
userSchema.virtual('name').get(function () {
  return this.first_name + ' ' + this.last_name;
});

var User = mongoose.model('User', userSchema);

exports.add_user = function(uid, st, fn, ln, tz, gd, callback) {
  var newUser = new User({
    id: uid,
    state: st,
    first_name: fn,
    last_name: ln,
    timezone: tz,
    gender: gd,
    buildingPollId: -1
  });
  newUser.save(callback);
};

exports.remove_user = function(user_id, callback) {
  User.remove({ id: user_id }, callback);
};

exports.get_user = function(user_id, callback) {
  User.findOne({ id: user_id }, callback);
};

exports.get_all_users = function(callback) {
  // i.e.
  // callback = function (err, users) {
  //   if (err) { return console.error(err); }
  //   callback(users);
  // }
  User.find(callback);
};

exports.get_other_users = function(user_id, callback) {
  // Get all users except user with id: user_id
  User.find({ id: { $ne: user_id } }, callback);
}

exports.set_user_state = function(user_id, state, action) {
  User.findOne({ id: user_id }, function(err, user) {
    user.state = state;
    user.save(function(err, savedUser) {
      if (err) { return console.error(err) }
      if (savedUser.state != state) {
        console.error("[ERROR] State of user: %s after %s is not %s", savedUser.state, action, state);
      }
    });
  });
}

exports.count = function(callback) {
  User.count({}, callback);
};
