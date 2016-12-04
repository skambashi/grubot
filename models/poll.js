var mongoose = require('mongoose'),
    ObjectID = require('mongodb').ObjectID;

var voteSchema = mongoose.Schema({
  user_id: String,
  choice_id: String,
  poll_id: String
});

var choiceSchema = mongoose.Schema({
  text: String,
  poll_id: String
});

var pollSchema = mongoose.Schema({
  owner: String,
  text: String,
});

var Poll = mongoose.model('Poll', pollSchema);

exports.add_poll = function(pollOwner, pollName, callback) {
  // callback signature for add_poll : function(err, newPoll)
  var newPoll = new Poll({
    owner: pollOwner,
    text: pollName
  });
  newPoll.save(callback);
};

exports.remove_poll = function(p_id, callback) {
  // callback signature for remove_poll: function(err)
  Poll.remove({ _id: new ObjectID(p_id) }, callback);
};

exports.get_all_polls = function(callback) {
  // callback signature for get_all_polls: function (err, polls)
  Poll.find(callback);
};
