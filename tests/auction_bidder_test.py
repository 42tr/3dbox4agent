import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sdk/python'))
from auction_bidder import bid
from auction_coordinator import valid_bid
import json

class BidTests(unittest.TestCase):
    def setUp(self):
        self.obs={'self':{'id':'drone-2','x':0,'y':0,'status':'idle','battery':80,'capabilities':['inspect']}}
        self.call={'v':1,'kind':'auction_call','auction':'abcdef12-1','task':'inspect','capability':'inspect','target':[3,4]}
    def test_cost_from_local_state(self):
        self.assertEqual(bid(self.obs,self.call),{'v':1,'kind':'auction_bid','auction':'abcdef12-1','task':'inspect','score':6})
    def test_ineligible_or_malformed(self):
        for key,value in [('status','working'),('battery',5),('capabilities',[])]:
            obs={'self':{**self.obs['self'],key:value}}
            self.assertIsNone(bid(obs,self.call))
        for patch in [{'target':[math.inf,1]},{'target':[True,1]},{'auction':'fake'},{'task':'bad/id'},{'capability':'not valid'},{'v':2}]:
            self.assertIsNone(bid(self.obs,{**self.call,**patch}))

class AuctionBidValidationTests(unittest.TestCase):
    def setUp(self):
        self.auction={'id':'abcdef12-1','task':'inspect','candidates':{'drone-2'},'opened':5,'until':20}
        self.message={'from':'drone-2','sentTick':9,'receivedTick':12,'text':json.dumps({'v':1,'kind':'auction_bid','auction':'abcdef12-1','task':'inspect','score':6})}
    def test_valid_bid(self):
        self.assertEqual(valid_bid(self.message,self.auction),('drone-2',6))
    def test_wrong_source_or_late_bid_is_ignored(self):
        for change in [{'from':'drone-3'},{'sentTick':4},{'receivedTick':21},{'text':'not json'},{'text':json.dumps({'v':1,'kind':'auction_bid','auction':'abcdef12-1','task':'inspect','score':float('nan')})}]:
            self.assertIsNone(valid_bid({**self.message,**change},self.auction))

if __name__=='__main__':unittest.main()
