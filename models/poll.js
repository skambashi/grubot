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
  text: String
});

var Poll = mongoose.model('Poll', pollSchema);
var Choice = mongoose.model('Choice', choiceSchema);
var Vote = mongoose.model('Vote', voteSchema);

exports.add_poll = function(pollOwner, pollQuestion, callback) {
  // callback signature for add_poll : function(err, newPoll)
  var newPoll = new Poll({
    owner: pollOwner,
    text: pollQuestion
  });
  newPoll.save(callback);
};

exports.remove_poll = function(p_id, callback) {
  // callback signature for remove_poll: function(err)
  Poll.remove({ _id: new ObjectID(p_id) }, callback);
};

exports.get_poll = function(p_id, callback) {
  Poll.findOne({ _id: new ObjectID(p_id) }, callback);
};

exports.get_all_polls = function(callback) {
  // callback signature for get_all_polls: function (err, polls)
  Poll.find(callback);
};

exports.add_choice = function(choiceName, pollId, callback) {
  var newChoice = new Choice({
    text: choiceName,
    poll_id: pollId
  });
  newChoice.save(callback);
};

exports.get_poll_choices = function(pollId, callback) {
  // callback signature for get_poll_choices: function(err, choices)
  Choice.find({ poll_id: pollId }, callback);
};

exports.add_vote = function(uid, choiceId, pollId, callback) {
  // callback signature for add_vote: function(err, newVote)
  var newVote = new Vote({
    user_id: uid,
    choice_id: choiceId,
    poll_id: pollId
  });
  newVote.save(callback);
};

exports.get_votes_for_choice = function(choiceId, callback) {
  // callback signature for get_votes_for_choice: function(err, votes)
  Vote.find({ choice_id: choiceId }, callback);
};

exports.get_votes_for_poll = function(pollId, callback) {
  // callback signature for get_votes_for_choice: function(err, votes)
  Vote.find({ poll_id: pollId }, callback);
};
